const api = require('../../utils/api.js');
const util = require('../../utils/util.js');
const poller = require('../../utils/poller.js');
const chart = require('../../utils/chart.js');
const config = require('../../utils/config.js');

/** 日期串 → YYYYMMDD */
function dateKey(s) {
  return String(s || '').replace(/\D/g, '').slice(0, 8);
}

/**
 * hero 展示的涨幅与日期：9:30 前行情已翻到今日（估算恒为 0/集合竞价噪声）
 * 但尚未开盘时，回退到已公布的上一净值日，保持上一交易日状态
 */
function heroEstimate(f) {
  const quoteDay = dateKey(f.dataDate);
  const navDay = dateKey(f.lastDayDate);
  if (
    util.beforeOpen() &&
    quoteDay && navDay && navDay < quoteDay &&
    f.lastDayPct !== null && f.lastDayPct !== undefined
  ) {
    return { pct: f.lastDayPct, date: f.lastDayDate };
  }
  return { pct: f.estPct, date: f.dataDate };
}

Page({
  data: {
    code: '',
    loading: true,
    fund: null,
    rows: [],
    inWatchlist: false,
    trend: null,
    trendDateText: '',
    trendLoaded: false,
    touchIdx: -1,
    touchTime: '',
    touchPct: '',
    touchCls: '',
    today: ''
  },

  onLoad(options) {
    this.setData({ code: options.code || '' });
    this._active = true;
    this._poller = poller.createPoller({
      interval: config.pollInterval,
      onlyTrading: true,
      guard: () => !!this.data.fund,
      onTick: () => this.load(true).then(() => this.loadTrend())
    });

    this.load(true).then(() => this.loadTrend());
  },

  onShow() {
    this._active = true;
    const code = this.data.code;
    if (code) this.setData({ inWatchlist: util.getCodes().indexOf(code) >= 0 });
    if (this._shownBefore && code) this.load(true).then(() => this.loadTrend());
    this._shownBefore = true;
    if (this._poller) this._poller.start();
  },

  onHide() {
    this._active = false;
    if (this._poller) this._poller.stop();
    this._loadSeq = (this._loadSeq || 0) + 1;
    this._trendSeq = (this._trendSeq || 0) + 1;
  },

  onUnload() {
    this.onHide();
  },

  onPullDownRefresh() {
    this.load(true, true).then(() => this.loadTrend());
  },

  load(silent, isPull) {
    const code = this.data.code;
    if (!code) return Promise.resolve();
    const seq = (this._loadSeq || 0) + 1;
    this._loadSeq = seq;
    if (!silent) this.setData({ loading: true });

    return api
      .estimate([code], true)
      .then((list) => {
        if (!this._active || seq !== this._loadSeq) return;
        const f = (list && list[0]) || null;
        if (!f) {
          this._fullLoaded = false;
          this._trendSeq = (this._trendSeq || 0) + 1;
          this.setData({ loading: false, fund: null, rows: [], trend: null, trendLoaded: true });
          return;
        }
        const hero = heroEstimate(f);
        const rows = (f.stocks || []).map((s) => {
          let deltaText = '';
          let deltaArrow = '';
          let deltaCls = 'flat';
          if (s.isNew) {
            deltaText = '新增';
            deltaCls = 'up';
          } else if (s.weightDelta !== null && s.weightDelta !== undefined) {
            const v = Number(s.weightDelta);
            if (Math.abs(v) >= 0.005) {
              deltaText = Math.abs(v).toFixed(2) + '%';
              deltaArrow = v > 0 ? '↑' : '↓';
              deltaCls = v > 0 ? 'up' : 'down';
            } else {
              deltaText = '0.00%';
            }
          }
          return {
            code: s.code,
            name: s.name,
            industry: s.industry || '',
            weightText: (Number(s.weight) * 100).toFixed(2) + '%',
            pctText: util.fmtPct(s.pct),
            cls: util.clsOf(s.pct),
            isNew: !!s.isNew,
            deltaText: deltaText,
            deltaArrow: deltaArrow,
            deltaCls: deltaCls
          };
        });

        // 后续加载只提交变化的字段
        if (this._fullLoaded) {
          const patch = {};
          const oldFund = this.data.fund || {};
          const period = f.holdingsPeriod || '未披露';
          if (period !== oldFund.periodText) patch['fund.periodText'] = period;
          const lastDayText = util.fmtPct(f.lastDayPct);
          const lastDayCls = util.clsOf(f.lastDayPct);
          if (lastDayText !== oldFund.lastDayPctText) patch['fund.lastDayPctText'] = lastDayText;
          if (lastDayCls !== oldFund.lastDayCls) patch['fund.lastDayCls'] = lastDayCls;
          const lastDayDate = util.fmtDate(f.lastDayDate);
          if (lastDayDate !== oldFund.lastDayDate) patch['fund.lastDayDate'] = lastDayDate;
          const coverageText = f.source === 'index'
            ? (f.bench && f.bench.name ? '跟踪指数 ' + f.bench.name : '跟踪指数')
            : (f.coverage ? '总占比 ' + f.coverage + '%' : '');
          if (coverageText !== oldFund.coverageText) patch['fund.coverageText'] = coverageText;
          if ((f.msg || '') !== oldFund.msg) patch['fund.msg'] = f.msg || '';
          if (f.name !== oldFund.name) patch['fund.name'] = f.name;
          const navText = util.fmtNav(f.prevNav);
          if (navText !== oldFund.prevNavText) patch['fund.prevNavText'] = navText;
          const navDate = util.fmtDate(f.navDate);
          if (navDate !== oldFund.prevNavDate) patch['fund.prevNavDate'] = navDate;
          const ftypeText = f.ftype || '';
          if (ftypeText !== oldFund.ftypeText) patch['fund.ftypeText'] = ftypeText;
          const sizeText = f.size ? (f.size / 100000000).toFixed(2) + ' 亿' : '';
          if (sizeText !== oldFund.sizeText) patch['fund.sizeText'] = sizeText;
          const isBond = /债|纯债|信用|利率/.test(ftypeText);
          if (isBond !== oldFund.isBond) patch['fund.isBond'] = isBond;
          const estPctText = util.fmtPct(hero.pct);
          const estCls = util.clsOf(hero.pct);
          if (estPctText !== oldFund.pctText) patch['fund.pctText'] = estPctText;
          if (estCls !== oldFund.cls) patch['fund.cls'] = estCls;
          const hasPct = hero.pct !== null && hero.pct !== undefined;
          if (hasPct !== oldFund.hasPct) patch['fund.hasPct'] = hasPct;
          const benchText = f.source === 'index' && f.bench && f.bench.name ? '跟踪 ' + f.bench.name : '';
          if (benchText !== oldFund.benchText) patch['fund.benchText'] = benchText;
          const benchDesc = f.source === 'index' && f.bench && f.bench.desc ? f.bench.desc : '';
          if (benchDesc !== oldFund.benchDesc) patch['fund.benchDesc'] = benchDesc;
          const newToday = util.fmtDataDate(hero.date);
          if (newToday !== this.data.today) patch.today = newToday;

          const oldRows = this.data.rows || [];
          if (rows.length !== oldRows.length || rows.some((row, i) =>
            !oldRows[i] || row.code !== oldRows[i].code ||
            row.name !== oldRows[i].name ||
            row.weightText !== oldRows[i].weightText || row.deltaText !== oldRows[i].deltaText ||
            row.deltaArrow !== oldRows[i].deltaArrow || row.deltaCls !== oldRows[i].deltaCls ||
            row.isNew !== oldRows[i].isNew || row.industry !== oldRows[i].industry
          )) {
            patch.rows = rows;
          } else {
            rows.forEach((row, i) => {
              if (row.pctText !== oldRows[i].pctText) patch['rows[' + i + '].pctText'] = row.pctText;
              if (row.cls !== oldRows[i].cls) patch['rows[' + i + '].cls'] = row.cls;
            });
          }
          if (Object.keys(patch).length) this.setData(patch);
        } else {
          this.setData({
            loading: false,
            today: util.fmtDataDate(hero.date),
            fund: {
              code: f.code,
              name: f.name,
              ftypeText: f.ftype || '',
              sizeText: f.size ? (f.size / 100000000).toFixed(2) + ' 亿' : '',
              prevNavText: util.fmtNav(f.prevNav),
              prevNavDate: util.fmtDate(f.navDate),
              pctText: util.fmtPct(hero.pct),
              cls: util.clsOf(hero.pct),
              isBond: /债|纯债|信用|利率/.test(String(f.ftype || '')),
              coverageText: f.source === 'index'
                ? (f.bench && f.bench.name ? '跟踪指数 ' + f.bench.name : '跟踪指数')
                : (f.coverage ? '总占比 ' + f.coverage + '%' : ''),
              benchText: f.source === 'index' && f.bench && f.bench.name ? '跟踪 ' + f.bench.name : '',
              benchDesc: f.source === 'index' && f.bench && f.bench.desc ? f.bench.desc : '',
              periodText: f.holdingsPeriod || '未披露',
              lastDayPctText: util.fmtPct(f.lastDayPct),
              lastDayCls: util.clsOf(f.lastDayPct),
              lastDayDate: util.fmtDate(f.lastDayDate),
              msg: f.msg || '',
              hasPct: hero.pct !== null && hero.pct !== undefined
            },
            rows: rows,
            inWatchlist: util.getCodes().indexOf(code) >= 0
          });
          this._fullLoaded = true;
        }
      })
      .catch((err) => {
        if (!this._active || seq !== this._loadSeq) return;
        this.setData({ loading: false });
        wx.showToast({ title: err.message || '加载失败', icon: 'none', duration: 2500 });
      })
      .then(() => {
        if (isPull) wx.stopPullDownRefresh();
      });
  },

  /* ---------- 当日分时走势 ---------- */
  loadTrend() {
    const code = this.data.code;
    if (!code || !this.data.fund || !this._active) return Promise.resolve();
    const seq = (this._trendSeq || 0) + 1;
    this._trendSeq = seq;
    return api
      .trend(code)
      .then((t) => {
        if (!this._active || seq !== this._trendSeq || !this.data.fund) return;
        const valid = !!(t && t.points && t.points.length > 1);
        if (!valid || !this.isCurrentData(t.date)) {
          this.setData({ trend: null, trendLoaded: true, touchIdx: -1, touchTime: '', touchPct: '', touchCls: '' });
          return;
        }
        const d = String(t.date || '').replace(/\D/g, '').slice(0, 8);
        this.setData(
          {
            trend: t,
            trendDateText: d.length === 8 ? d.slice(4, 6) + '-' + d.slice(6, 8) : '',
            'fund.benchDesc': t.benchDesc || (this.data.fund && this.data.fund.benchDesc) || '',
            trendLoaded: true,
            touchIdx: -1,
            touchTime: '',
            touchPct: '',
            touchCls: ''
          },
          () => this.drawChart(-1)
        );
      })
      .catch(() => {
        if (!this._active || seq !== this._trendSeq) return;
        this.setData({ trend: null, trendLoaded: true, touchIdx: -1, touchTime: '', touchPct: '', touchCls: '' });
      });
  },

  isCurrentData(date) {
    const now = new Date();
    const d = String(date || '').replace(/\D/g, '').slice(0, 8);
    const beforeOpen = now.getHours() * 60 + now.getMinutes() < 9 * 60 + 30;
    if (!d) return util.isTrading(now) || beforeOpen;
    return d === util.todayStr(now) || beforeOpen;
  },

  onTouchChart(e) {
    const trend = this.data.trend;
    if (!trend || !trend.points || trend.points.length < 2) return;
    const touch = e.touches && e.touches[0];
    if (!touch) return;
    const idx = chart.hitTest(trend, touch.x, this._chartW || 1);
    if (idx < 0) return;
    const p = trend.points[idx];
    if (this.data.touchIdx === idx) return;
    this.setData({
      touchIdx: idx,
      touchTime: p.t,
      touchPct: (p.pct >= 0 ? '+' : '') + p.pct.toFixed(2) + '%',
      touchCls: util.clsOf(p.pct)
    });
    this.drawChart(idx);
  },

  onTouchEnd() {
    if (this.data.touchIdx < 0) return;
    this.setData({ touchIdx: -1, touchTime: '', touchPct: '', touchCls: '' });
    this.drawChart(-1);
  },

  drawChart(selIdx) {
    const trend = this.data.trend;
    if (!this._active || !trend || !trend.points || trend.points.length < 2) return;
    if (this._canvas && this._chartW && this._chartH) {
      chart.drawTrend(this._canvas, { width: this._chartW, height: this._chartH }, trend, selIdx);
      return;
    }
    wx.createSelectorQuery()
      .in(this)
      .select('#trendCanvas')
      .fields({ node: true, size: true })
      .exec((res) => {
        if (!this._active || this.data.trend !== trend) return;
        const item = res && res[0];
        // 节点未就绪（首绘常见），延一帧重试
        if (!item || !item.node) {
          if ((this._drawRetry || 0) < 3) {
            this._drawRetry = (this._drawRetry || 0) + 1;
            setTimeout(() => this.drawChart(selIdx), 30);
          }
          return;
        }
        this._drawRetry = 0;
        this._canvas = item.node;
        this._chartW = item.width;
        this._chartH = item.height;
        chart.drawTrend(item.node, { width: item.width, height: item.height }, trend, selIdx);
      });
  },

  /** 自选切换 */
  toggleWatch() {
    const code = this.data.code;
    if (this.data.inWatchlist) {
      util.removeCode(code);
    } else {
      util.addCode(code);
    }
    this.setData({ inWatchlist: !this.data.inWatchlist });
  }
});
