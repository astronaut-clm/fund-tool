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
    trendLoaded: false,
    touchIdx: -1,
    touchTip: '',
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
        // 分时点数多，每 6 个 tick（60s）刷一次
        if (tick % 6 === 0) this.loadTrend();
      }
    });
    // 顺序化：先 load（会预热 info/holdings 缓存），完成后再拉 trend，
    // 复用同一已热实例，避免双实例冷启动 + 缓存 miss
    this.load(true).then(() => this.loadTrend());
  },

  onShow() {
    // 从首页返回时自选状态可能已变，同步一下
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
          // 较上期：新增 / 变动百分点（红↑绿↓）
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

        const now = new Date();
        const today = util.pad2(now.getMonth() + 1) + '-' + util.pad2(now.getDate());

        const isPolling = !!this._fullLoaded;

        if (isPolling) {
          // 轮询路径：只更新会变的字段，名称/类型/规模/净值不动
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
          // 涨幅用云函数 estPct（和首页同源）
          const estPctText = util.fmtPct(f.estPct);
          const estCls = util.clsOf(f.estPct);
          if (estPctText !== oldFund.pctText) patch['fund.pctText'] = estPctText;
          if (estCls !== oldFund.cls) patch['fund.cls'] = estCls;
          patch['fund.hasPct'] = f.estPct !== null && f.estPct !== undefined;
          patch['lastTime'] = util.nowText();

          // rows 增量：只更新会变的字段（涨跌幅）
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

        this.applyTrendPct();
      })
      .catch((err) => {
        this.setData({ loading: false });
        wx.showToast({ title: err.message || '加载失败', icon: 'none', duration: 2500 });
      })
      .then(() => {
        if (isPull) wx.stopPullDownRefresh();
      });
  },

  /** ---------- 当日分时走势 ---------- */

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
          this.setData({ trend: null, trendLoaded: true, touchIdx: -1, touchTip: '' });
        } else {
          // 关键：drawChart 必须在 setData 渲染完成后调用，
          // 否则 wx:if 包裹的 canvas 节点尚未建好，selectorQuery 拿不到
          this.setData({ trend: t, trendLoaded: true, touchIdx: -1, touchTip: '' }, () => {
            this.drawChart(-1);
          });
        }
        this.applyTrendPct();
      })
      .catch(() => {
        this.setData({ trend: null, trendLoaded: true });
      });
  },

  applyTrendPct() {
    // 涨幅统一用云函数 estimate 返回的 estPct（和首页同源），
    // 分时图只用于绘制曲线，不再覆盖涨幅值，避免两边不一致
    const fund = this.data.fund;
    if (!fund) return;
    // fund.pctText 已在 load() 中由 f.estPct 设置，这里不再覆盖
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
    // x 轴按点索引均布（与 chart.js 绘制一致），直接按比例取索引
    const idx = Math.round(ratio * (pts.length - 1));
    const p = pts[idx];
    if (this.data.touchIdx === idx) return;
    this.setData({
      touchIdx: idx,
      touchTip: p.t + '  ' + (p.pct >= 0 ? '+' : '') + p.pct.toFixed(2) + '%'
    });
    this.drawChart(idx);
  },

  onTouchEnd() {
    if (this.data.touchIdx < 0) return;
    this.setData({ touchIdx: -1, touchTip: '' });
    this.drawChart(-1);
  },

  drawChart(selIdx) {
    const trend = this.data.trend;
    if (!trend || !trend.points || trend.points.length < 2) return;
    const size = { width: this._chartW, height: this._chartH };
    // 命中缓存：同步绘制；未命中：首次 query 后缓存
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
            // 节点尚未就绪（常见于首绘），延一帧再试，避免静默丢帧
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

  /** 自选切换：添加 / 移出 */
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
