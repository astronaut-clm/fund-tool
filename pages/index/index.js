const api = require('../../utils/api.js');
const util = require('../../utils/util.js');
const poller = require('../../utils/poller.js');

Page({
  data: {
    keyword: '',
    results: [],
    showResults: false,
    searching: false,
    funds: [],
    history: [],
    dragIndex: -1,
    dragOverIndex: -1
  },

  onLoad() {
    this._poller = poller.createPoller({
      interval: 10000,
      onlyTrading: true,
      guard: () => util.getCodes().length > 0 && this.data.funds.length > 0,
      onTick: () => this.load()
    });
    this.setData({ history: util.getHistory() });
    this.load();
  },

  onShow() {
    // 从详情页返回：若搜索窗口还开着，只刷新搜索结果的 added 状态，不清空搜索
    // 若搜索窗口已关闭，刷新自选列表
    if (this.data.showResults && this.data.results.length) {
      const codes = util.getCodes();
      const results = this.data.results.map((it) => ({
        code: it.code,
        name: it.name,
        type: it.type,
        added: codes.indexOf(it.code) >= 0
      }));
      this.setData({ results: results });
    } else if (!this.data.showResults) {
      this.load();
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
    this.load(true);
  },

  /** 点击页面空白处收起搜索，同时刷新自选列表 */
  onPageTap() {
    if (this.data.showResults) {
      this.setData({ showResults: false, searching: false });
      this.load();
    }
  },

  /** 空操作，用于 catchtap 阻止冒泡 */
  noop() {},

  /** ---------- 搜索 ---------- */

  onInput(e) {
    const key = (e.detail.value || '').trim();
    this.setData({ keyword: e.detail.value || '' });
    if (this._timer) clearTimeout(this._timer);
    if (!key) {
      // 清空输入：有历史则保持展开显示历史，无历史则收起
      this.setData({ results: [], showResults: this.data.history.length > 0, searching: false });
      return;
    }
    this.setData({ showResults: true, searching: true });
    this._timer = setTimeout(() => {
      this.doSearch(key);
    }, 350);
  },

  onSearchBarTap() {
    // 点击搜索栏立即展开（tap 比 input 的 focus 事件触发更快）
    this.setData({ showResults: true });
  },

  onClearSearch() {
    this.setData({ keyword: '', results: [], showResults: false, searching: false });
  },

  doSearch(key) {
    // 请求序号竞态保护：旧请求晚到时直接丢弃，避免覆盖新结果
    const seq = (this._seq || 0) + 1;
    this._seq = seq;
    api
      .search(key)
      .then((list) => {
        if (seq !== this._seq) return;
        const codes = util.getCodes();
        const seen = {};
        const results = [];
        (list || []).forEach((it) => {
          // 同一基金代码只保留一条（服务端已过滤股票/指数，这里再兜底去重）
          if (seen[it.code]) return;
          seen[it.code] = true;
          results.push({
            code: it.code,
            name: it.name,
            type: it.type,
            added: codes.indexOf(it.code) >= 0
          });
        });
        this.setData({ results: results, searching: false });
      })
      .catch((err) => {
        if (seq !== this._seq) return;
        this.setData({ results: [], searching: false });
        wx.showToast({ title: err.message || '搜索失败', icon: 'none' });
      });
  },

  onPickFund(e) {
    // 搜索结果左侧信息区点击跳详情页
    const code = e.currentTarget.dataset.code;
    const name = e.currentTarget.dataset.name;
    // 记录搜索历史（不超过 10 条）
    if (code && name) {
      util.addHistory(code, name);
      this.setData({ history: util.getHistory() });
    }
    wx.navigateTo({ url: '/pages/detail/detail?code=' + code });
  },

  /** 搜索结果右侧 +/- 自选按钮 */
  onTogglePick(e) {
    const code = e.currentTarget.dataset.code;
    const name = e.currentTarget.dataset.name;
    const idx = e.currentTarget.dataset.index;
    const added = this.data.results[idx] && this.data.results[idx].added;
    if (added) {
      util.removeCode(code);
    } else {
      util.addCode(code);
      // 记录搜索历史
      if (name) {
        util.addHistory(code, name);
        this.setData({ history: util.getHistory() });
      }
    }
    // 更新该项 added 状态
    this.setData({
      ['results[' + idx + '].added']: !added
    });
    // 刷新自选列表（不切走搜索，静默刷新）
    this.load();
  },

  onPickHistory(e) {
    const code = e.currentTarget.dataset.code;
    wx.navigateTo({ url: '/pages/detail/detail?code=' + code });
  },

  onClearHistory() {
    util.clearHistory();
    this.setData({ history: [] });
  },

  /** ---------- 列表 ---------- */

  load(isPull) {
    const codes = util.getCodes();
    if (!codes.length) {
      this.setData({ funds: [] });
      if (isPull) wx.stopPullDownRefresh();
      return Promise.resolve();
    }

    return api
      .estimate(codes, false)
      .then((list) => {
        const funds = (list || []).map((f) => {
          // 当日净值已公布（lastDayDate 为今天）时，直接用真实涨幅；
          // 否则用估算涨幅。这样首页永远是用户最关心的那个数。
          const today = util.todayStr();
          const dayDate = String(f.lastDayDate || '').replace(/\D/g, '').slice(0, 8);
          const useActual =
            f.lastDayPct !== null &&
            f.lastDayPct !== undefined &&
            dayDate &&
            dayDate === today;
          const pct = useActual ? f.lastDayPct : f.estPct;
          return {
            code: f.code,
            name: f.name,
            pctText: util.fmtPct(pct),
            cls: util.clsOf(pct)
          };
        });
        this.setData({ funds: funds });
      })
      .catch((err) => {
        wx.showToast({ title: err.message || '加载失败', icon: 'none', duration: 2500 });
      })
      .then(() => {
        if (isPull) wx.stopPullDownRefresh();
      });
  },

  /** ---------- 拖拽排序 ---------- */

  onDragTouchStart(e) {
    const idx = e.currentTarget.dataset.index;
    const touch = e.touches[0];
    this._dragStartY = touch.clientY;
    this._dragItemH = 0;
    // 测量单项高度（后续用 itemH = clientY 差 / 行高 算目标位置）
    const q = wx.createSelectorQuery().in(this);
    q.selectAll('.fund').boundingClientRect();
    q.exec((res) => {
      const rects = res && res[0];
      if (rects && rects.length) this._dragItemH = rects[0].height;
    });
    this.setData({ dragIndex: idx });
  },

  onDragTouchMove(e) {
    const dragIndex = this.data.dragIndex;
    if (dragIndex < 0) return;
    const touch = e.touches[0];
    const dy = touch.clientY - this._dragStartY;
    // 用 dy + 当前项起点位置 算出落点位置
    if (!this._dragItemH) return;
    const funds = this.data.funds;
    // 当前拖动项的位置 = 起点 + dy
    const overIndex = Math.max(0, Math.min(funds.length - 1, dragIndex + Math.round(dy / this._dragItemH)));
    if (overIndex !== this.data.dragOverIndex) {
      this.setData({ dragOverIndex: overIndex });
    }
  },

  onDragTouchEnd() {
    const { dragIndex, dragOverIndex, funds } = this.data;
    if (dragIndex < 0 || dragOverIndex < 0 || dragIndex === dragOverIndex) {
      this.setData({ dragIndex: -1, dragOverIndex: -1 });
      return;
    }
    // 数组重排
    const list = funds.slice();
    const moved = list.splice(dragIndex, 1)[0];
    list.splice(dragOverIndex, 0, moved);
    // 同步存储顺序
    util.setCodes(list.map((f) => f.code));
    this.setData({ funds: list, dragIndex: -1, dragOverIndex: -1 });
  },

  goDetail(e) {
    const code = e.currentTarget.dataset.code;
    wx.navigateTo({ url: '/pages/detail/detail?code=' + code });
  }
});
