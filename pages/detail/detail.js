const api = require('../../utils/api.js');
const util = require('../../utils/util.js');

Page({
  data: {
    code: '',
    loading: true,
    fund: null,
    rows: [],
    lastTime: '',
    inWatchlist: true,
    trend: null,
    trendLoaded: false,
    touchIdx: -1,
    touchTip: '',
    today: ''
  },

  onLoad(options) {
    const code = options.code || '';
    this.setData({ code: code });
    this.load(true);
    this.loadTrend();
  },

  onShow() {
    this.startPolling();
  },

  onHide() {
    this.stopPolling();
  },

  onUnload() {
    this.stopPolling();
  },

  onPullDownRefresh() {
    this.loadTrend();
    this.load(true, true);
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
        const rows = (f.stocks || []).map((s) => ({
          code: s.code,
          name: s.name,
          weightText: (Number(s.weight) * 100).toFixed(2) + '%',
          pctText: util.fmtPct(s.pct),
          cls: util.clsOf(s.pct)
        }));

        const now = new Date();
        const p2 = (n) => (n < 10 ? '0' : '') + n;

        this.setData({
          loading: false,
          today: p2(now.getMonth() + 1) + '-' + p2(now.getDate()),
          fund: {
            code: f.code,
            name: f.name,
            ftypeText: f.ftype || '',
            sizeText: f.size ? (f.size / 100000000).toFixed(2) + ' 亿' : '',
            prevNavText: util.fmtNav(f.prevNav),
            prevNavDate: util.fmtDate(f.navDate),
            pctText: util.fmtPct(f.estPct),
            cls: util.clsOf(f.estPct),
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
        this.setData({ trend: t || null, trendLoaded: true, touchIdx: -1, touchTip: '' });
        if (t && t.points && t.points.length > 1) this.drawChart(-1);
      })
      .catch(() => {
        this.setData({ trend: null, trendLoaded: true });
      });
  },

  onTouchChart(e) {
    const trend = this.data.trend;
    if (!trend || !trend.points || trend.points.length < 2) return;
    const touch = e.touches && e.touches[0];
    if (!touch) return;
    const ratio = Math.min(1, Math.max(0, touch.x / (this._chartW || 1)));
    const idx = Math.round(ratio * (trend.points.length - 1));
    const p = trend.points[idx];
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

    wx.createSelectorQuery()
      .in(this)
      .select('#trendCanvas')
      .fields({ node: true, size: true })
      .exec((res) => {
        const item = res && res[0];
        if (!item || !item.node) return;
        const canvas = item.node;
        const ctx = canvas.getContext('2d');
        const dpr = (wx.getWindowInfo && wx.getWindowInfo().pixelRatio) || 2;
        const W = item.width;
        const H = item.height;
        this._chartW = W;
        canvas.width = W * dpr;
        canvas.height = H * dpr;
        ctx.scale(dpr, dpr);
        ctx.clearRect(0, 0, W, H);

        const pts = trend.points;
        const padT = 18;
        const padB = 16;
        const padX = 46;
        const chartW = W - padX - 8;
        const chartH = H - padT - padB;

        // y 值域：估算净值，纳入上一净值基准
        let values = pts.map((p) => p.nav);
        values.push(trend.prevNav);
        let min = Math.min.apply(null, values);
        let max = Math.max.apply(null, values);
        const span = (max - min) || Math.abs(trend.prevNav) * 0.002;
        min -= span * 0.12;
        max += span * 0.12;

        const xAt = (i) => padX + (chartW * i) / (pts.length - 1);
        const yAt = (v) => padT + chartH * (1 - (v - min) / (max - min));

        const lastPct = pts[pts.length - 1].pct;
        const rising = lastPct >= 0;
        const mainColor = rising ? '#e0403f' : '#12a05c';

        // 网格（按零轴上下等分）
        ctx.lineWidth = 1;
        ctx.strokeStyle = '#f0f1f3';
        ctx.beginPath();
        for (let g = 0; g <= 4; g++) {
          const y = padT + (chartH * g) / 4;
          ctx.moveTo(padX, y);
          ctx.lineTo(padX + chartW, y);
        }
        ctx.stroke();

        // 上一净值基准线
        const yBase = yAt(trend.prevNav);
        ctx.setLineDash([4, 4]);
        ctx.strokeStyle = '#c9ced4';
        ctx.beginPath();
        ctx.moveTo(padX, yBase);
        ctx.lineTo(padX + chartW, yBase);
        ctx.stroke();
        ctx.setLineDash([]);

        // 面积渐变
        const grad = ctx.createLinearGradient(0, padT, 0, padT + chartH);
        grad.addColorStop(0, rising ? 'rgba(224,64,63,0.22)' : 'rgba(18,160,92,0.22)');
        grad.addColorStop(1, rising ? 'rgba(224,64,63,0.02)' : 'rgba(18,160,92,0.02)');
        ctx.beginPath();
        ctx.moveTo(xAt(0), yAt(pts[0].nav));
        pts.forEach((p, i) => {
          ctx.lineTo(xAt(i), yAt(p.nav));
        });
        ctx.lineTo(xAt(pts.length - 1), padT + chartH);
        ctx.lineTo(xAt(0), padT + chartH);
        ctx.closePath();
        ctx.fillStyle = grad;
        ctx.fill();

        // 折线
        ctx.beginPath();
        pts.forEach((p, i) => {
          const x = xAt(i);
          const y = yAt(p.nav);
          if (i === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        });
        ctx.lineWidth = 2;
        ctx.strokeStyle = mainColor;
        ctx.stroke();

        // 左侧刻度文字
        ctx.font = '10px -apple-system, sans-serif';
        ctx.fillStyle = '#8a9099';
        ctx.textAlign = 'right';
        ctx.textBaseline = 'middle';
        for (let g = 0; g <= 4; g++) {
          const v = max - ((max - min) * g) / 4;
          const y = padT + (chartH * g) / 4;
          ctx.fillText(((v / trend.prevNav - 1) * 100).toFixed(2) + '%', padX - 6, y);
        }
        ctx.fillStyle = '#6b7280';
        ctx.fillText('0.00%', padX - 6, yBase);

        // 底部时间轴：A股时段刻度，按数据里真实时间点定位 x
        ctx.textBaseline = 'top';
        ctx.fillStyle = '#8a9099';
        const toMin = (s) => Number(s.slice(0, 2)) * 60 + Number(s.slice(3));
        const ticks = ['09:30', '13:00', '15:00'];
        ticks.forEach(function (tk) {
          let idx = 0;
          let best = Infinity;
          const target = toMin(tk);
          pts.forEach(function (p, i) {
            const d = Math.abs(toMin(p.t) - target);
            if (d < best) { best = d; idx = i; }
          });
          ctx.textAlign = idx === 0 ? 'left' : idx === pts.length - 1 ? 'right' : 'center';
          ctx.fillText(tk, xAt(idx), padT + chartH + 4);
        });

        // 触摸游标
        if (selIdx >= 0 && selIdx < pts.length) {
          const x = xAt(selIdx);
          const y = yAt(pts[selIdx].nav);
          ctx.strokeStyle = '#9aa3ad';
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.moveTo(x, padT);
          ctx.lineTo(x, padT + chartH);
          ctx.stroke();
          ctx.beginPath();
          ctx.arc(x, y, 3.5, 0, Math.PI * 2);
          ctx.fillStyle = '#ffffff';
          ctx.fill();
          ctx.strokeStyle = mainColor;
          ctx.lineWidth = 2;
          ctx.stroke();
        }
      });
  },

  toggleWatch() {
    const code = this.data.code;
    if (this.data.inWatchlist) {
      util.removeCode(code);
      this.setData({ inWatchlist: false });
    } else {
      util.addCode(code);
      this.setData({ inWatchlist: true });
    }
  },

  startPolling() {
    this.stopPolling();
    this._tick = 0;
    this._poll = setInterval(() => {
      if (!util.isTrading()) return;
      this.load(true);
      // 分时重量轻但点数多，每 6 个 tick（60s）刷一次即可
      this._tick = (this._tick || 0) + 1;
      if (this._tick % 6 === 0) this.loadTrend();
    }, 10000);
  },

  stopPolling() {
    if (this._poll) {
      clearInterval(this._poll);
      this._poll = null;
    }
  }
});
