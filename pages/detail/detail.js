const api = require('../../utils/api.js');
const util = require('../../utils/util.js');
const poller = require('../../utils/poller.js');
const chart = require('../../utils/chart.js');

Page({
  data: {
    code: '',
    loading: true,
    fund: null,
    rows: [],
    lastTime: '',
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
    const code = options.code || '';
    this.setData({ code: code });
    this._poller = poller.createPoller({
      interval: 10000,
      onlyTrading: true,
      guard: () => !!this.data.fund,
      onTick: (tick) => {
        this.load(true);
        if (tick % 6 === 0) this.loadTrend(); // 分时每 60s 刷一次
      }
    });
    // 先 load 预热缓存，再拉 trend，复用同一实例避免冷启动
    this.load(true).then(() => this.loadTrend());
  },

  onShow() {
    // 从首页返回时同步自选状态
    const code = this.data.code;
    if (code) {
      this.setData({ inWatchlist: util.getCodes().indexOf(code) >= 0 });
    }
    if (this._poller) this._poller.start();
  },

  onHide() {
    if (this._poller) this._poller.stop();
  },

  onUnload() {
    if (this._poller) this._poller.stop();
  },

  onPullDownRefresh() {
    this.load(true, true).then(() => this.loadTrend());
  },

  load(silent, isPull) {
    const code = this.data.code;
    if (!code) return Promise.resolve();
    if (!silent) this.setData({ loading: true });

    return api
      .estimate([code], true)
      .then((list) => {
        const f = (list && list[0]) || null;
        if (!f) {
          this.setData({ loading: false, fund: null });
          return;
        }
        const rows = (f.stocks || []).map((s) => {
          // 较上期：新增 / 变动百分点
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
          const price = Number(s.price);
          return {
            code: s.code,
            name: s.name,
            industry: s.industry || '',
            priceText: Number.isFinite(price) && price > 0 ? price.toFixed(2) : '',
            weightText: (Number(s.weight) * 100).toFixed(2) + '%',
            pctText: util.fmtPct(s.pct),
            cls: util.clsOf(s.pct),
            isNew: !!s.isNew,
            deltaText: deltaText,
            deltaArrow: deltaArrow,
            deltaCls: deltaCls
          };
        });

        const today = util.fmtDataDate(f.dataDate);

        const isPolling = !!this._fullLoaded;

        if (isPolling) {
          // 轮询：只更新会变的字段，名称/类型/规模不动
          const patch = {};
          const oldFund = this.data.fund || {};
          if (f.holdingsPeriod && f.holdingsPeriod !== oldFund.periodText) {
            patch['fund.periodText'] = f.holdingsPeriod;
          }
          if (f.lastDayPct !== undefined) {
            const newText = util.fmtPct(f.lastDayPct);
            const newCls = util.clsOf(f.lastDayPct);
            if (newText !== oldFund.lastDayPctText) patch['fund.lastDayPctText'] = newText;
            if (newCls !== oldFund.lastDayCls) patch['fund.lastDayCls'] = newCls;
          }
          if (f.lastDayDate && f.lastDayDate !== oldFund.lastDayDate) {
            patch['fund.lastDayDate'] = util.fmtDate(f.lastDayDate);
          }
          if (f.msg !== oldFund.msg) patch['fund.msg'] = f.msg;
          const estPctText = util.fmtPct(f.estPct);
          const estCls = util.clsOf(f.estPct);
          if (estPctText !== oldFund.pctText) patch['fund.pctText'] = estPctText;
          if (estCls !== oldFund.cls) patch['fund.cls'] = estCls;
          patch['fund.hasPct'] = f.estPct !== null && f.estPct !== undefined;
          const newToday = util.fmtDataDate(f.dataDate);
          if (newToday && newToday !== this.data.today) patch['today'] = newToday;
          patch['lastTime'] = util.nowText();

          // rows 增量：只更新涨跌幅
          const oldRows = this.data.rows || [];
          for (let i = 0; i < rows.length; i++) {
            if (!oldRows[i]) break;
            if (rows[i].pctText !== oldRows[i].pctText) {
              patch['rows[' + i + '].pctText'] = rows[i].pctText;
            }
            if (rows[i].cls !== oldRows[i].cls) {
              patch['rows[' + i + '].cls'] = rows[i].cls;
            }
          }
          this.setData(patch);
        } else {
          this.setData({
            loading: false,
            today: today,
            fund: {
              code: f.code,
              name: f.name,
              ftypeText: f.ftype || '',
              sizeText: f.size ? (f.size / 100000000).toFixed(2) + ' 亿' : '',
              prevNavText: util.fmtNav(f.prevNav),
              prevNavDate: util.fmtDate(f.navDate),
              pctText: util.fmtPct(f.estPct),
              cls: util.clsOf(f.estPct),
              isBond: /债|纯债|信用|利率/.test(String(f.ftype || '')),
              coverageText: f.source === 'index'
                ? (f.bench && f.bench.name ? '跟踪指数 ' + f.bench.name : '跟踪指数')
                : (f.coverage ? '总占比 ' + f.coverage + '%' : ''),
              benchText: f.source === 'index' && f.bench && f.bench.name
                ? '跟踪 ' + f.bench.name
                : '',
              benchDesc: f.source === 'index' && f.bench && f.bench.desc
                ? f.bench.desc
                : '',
              periodText: f.holdingsPeriod || '未披露',
              lastDayPctText: util.fmtPct(f.lastDayPct),
              lastDayCls: util.clsOf(f.lastDayPct),
              lastDayDate: util.fmtDate(f.lastDayDate),
              msg: f.msg || '',
              hasPct: f.estPct !== null && f.estPct !== undefined
            },
            rows: rows,
            lastTime: util.nowText(),
            inWatchlist: util.getCodes().indexOf(code) >= 0
          });
          this._fullLoaded = true;
        }
      })
      .catch((err) => {
        this.setData({ loading: false });
        wx.showToast({ title: err.message || '加载失败', icon: 'none', duration: 2500 });
      })
      .then(() => {
        if (isPull) wx.stopPullDownRefresh();
      });
  },

  /** 当日分时走势 */

  loadTrend() {
    const code = this.data.code;
    if (!code) return Promise.resolve();
    return api
      .trend(code)
      .then((t) => {
        const valid = !!(t && t.points && t.points.length > 1);
        const isCurrent = valid && this.isCurrentData(t.date);
        this._trendData = t;

        if (!isCurrent) {
          this.setData({ trend: null, trendLoaded: true, touchIdx: -1, touchTime: '', touchPct: '', touchCls: '' });
        } else {
          // 日期 YYYYMMDD → MM-DD
          const d = String(t.date || '').replace(/\D/g, '').slice(0, 8);
          const trendDateText = d.length === 8 ? d.slice(4, 6) + '-' + d.slice(6, 8) : '';
          const benchDesc = t.benchDesc || this.data.fund.benchDesc || '';
          this.setData({ trend: t, trendDateText: trendDateText, 'fund.benchDesc': benchDesc, trendLoaded: true, touchIdx: -1, touchTime: '', touchPct: '', touchCls: '' }, () => {
            this.drawChart(-1);
          });
        }
      })
      .catch(() => {
        this.setData({ trend: null, trendLoaded: true });
      });
  },

  isCurrentData(date) {
    const now = new Date();
    const today = util.todayStr(now);
    const d = String(date || '').replace(/\D/g, '').slice(0, 8);
    const nowMin = now.getHours() * 60 + now.getMinutes();
    if (!d) {
      if (util.isTrading(now)) return true;
      return nowMin < 9 * 60 + 30;
    }
    if (d === today) return true;
    return nowMin < 9 * 60 + 30;
  },

  onTouchChart(e) {
    const trend = this.data.trend;
    if (!trend || !trend.points || trend.points.length < 2) return;
    const touch = e.touches && e.touches[0];
    if (!touch) return;
    const pts = trend.points;
    const padX = 46;
    const W = this._chartW || 1;
    const chartW = W - padX - 8;
    const ratio = Math.min(1, Math.max(0, (touch.x - padX) / chartW));
    const idx = Math.round(ratio * (pts.length - 1));
    const p = pts[idx];
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
    if (!trend || !trend.points || trend.points.length < 2) return;
    const size = { width: this._chartW, height: this._chartH };
    if (this._canvas && this._chartW && this._chartH) {
      chart.drawTrend(this._canvas, size, trend, selIdx);
    } else {
      wx.createSelectorQuery()
        .in(this)
        .select('#trendCanvas')
        .fields({ node: true, size: true })
        .exec((res) => {
          const item = res && res[0];
          if (!item || !item.node) {
            // 节点未就绪（首绘常见），延一帧重试
            if (this._drawRetry < 3) {
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
    }
  },

  /** 自选切换 */
  toggleWatch() {
    const code = this.data.code;
    if (this.data.inWatchlist) {
      util.removeCode(code);
      this.setData({ inWatchlist: false });
    } else {
      util.addCode(code);
      this.setData({ inWatchlist: true });
    }
  }
});
