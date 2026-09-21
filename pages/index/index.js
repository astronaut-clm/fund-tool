const api = require('../../utils/api.js');
const util = require('../../utils/util.js');

Page({
  data: {
    keyword: '',
    results: [],
    showResults: false,
    searching: false,
    funds: []
  },

  onLoad() {
    this.load();
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
    this.load(true);
  },

  /** ---------- 搜索 ---------- */

  onInput(e) {
    const key = (e.detail.value || '').trim();
    this.setData({ keyword: e.detail.value || '' });
    if (this._timer) clearTimeout(this._timer);
    if (!key) {
      this.setData({ results: [], showResults: false, searching: false });
      return;
    }
    this.setData({ showResults: true, searching: true });
    this._timer = setTimeout(() => {
      this.doSearch(key);
    }, 350);
  },

  onFocus() {
    if (this.data.keyword) this.setData({ showResults: true });
  },

  onClearSearch() {
    this.setData({ keyword: '', results: [], showResults: false, searching: false });
  },

  doSearch(key) {
    api
      .search(key)
      .then((list) => {
        const codes = util.getCodes();
        const results = (list || []).map((it) => ({
          code: it.code,
          name: it.name,
          type: it.type,
          added: codes.indexOf(it.code) >= 0
        }));
        this.setData({ results: results, searching: false });
      })
      .catch((err) => {
        this.setData({ results: [], searching: false });
        wx.showToast({ title: err.message || '搜索失败', icon: 'none' });
      });
  },

  onPickFund(e) {
    const code = e.currentTarget.dataset.code;
    util.addCode(code);
    // 更新搜索结果里该项为"已添加"
    const results = this.data.results.map((it) => {
      if (it.code === code) it.added = true;
      return it;
    });
    this.setData({ results: results });
    wx.showToast({ title: '已添加', icon: 'success' });
    this.load();
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
        const funds = (list || []).map((f) => ({
          code: f.code,
          name: f.name,
          pctText: util.fmtPct(f.estPct),
          navText: util.fmtNav(f.estNav),
          cls: util.clsOf(f.estPct),
          hasVal: f.estNav !== null && f.estNav !== undefined
        }));
        this.setData({ funds: funds });
      })
      .catch((err) => {
        wx.showToast({ title: err.message || '加载失败', icon: 'none', duration: 2500 });
      })
      .then(() => {
        if (isPull) wx.stopPullDownRefresh();
      });
  },

  goDetail(e) {
    const code = e.currentTarget.dataset.code;
    wx.navigateTo({ url: '/pages/detail/detail?code=' + code });
  },

  /** ---------- 轮询：仅交易时段的股价行情每 10s 更新 ---------- */

  startPolling() {
    this.stopPolling();
    if (!util.getCodes().length) return;
    this._poll = setInterval(() => {
      if (!util.isTrading()) return;
      if (!this.data.funds.length) return;
      this.load();
    }, 10000);
  },

  stopPolling() {
    if (this._poll) {
      clearInterval(this._poll);
      this._poll = null;
    }
  }
});
