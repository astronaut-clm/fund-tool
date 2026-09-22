const api = require('../../utils/api.js');
const util = require('../../utils/util.js');
const poller = require('../../utils/poller.js');

/** 拖拽震动：自带节流，避免快速拖动时连续触发 */
function vibrate(type) {
  const now = Date.now();
  if (now - (vibrate._t || 0) < 80) return;
  vibrate._t = now;
  wx.vibrateShort({ type: type, fail: function () {} });
}

Page({
  data: {
    keyword: '',
    results: [],
    showResults: false,
    searching: false,
    funds: [],
    history: [],
    dragIndex: -1,
    dragOverIndex: -1,
    dragOffsetY: 0,
    editMode: false,
    selectedCount: 0,
    allSelected: false
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
    // 从详情页返回：搜索窗口开则刷新 added 状态，关则刷新自选列表
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

  /** 点击空白处收起搜索并刷新自选列表 */
  onPageTap() {
    if (this.data.showResults) {
      this.setData({ showResults: false, searching: false });
      this.load();
    }
  },

  /** 空操作，用于 catchtap 阻止冒泡 */
  noop() {},

  /** 搜索 */

  onInput(e) {
    const key = (e.detail.value || '').trim();
    this.setData({ keyword: e.detail.value || '' });
    if (this._timer) clearTimeout(this._timer);
    if (!key) {
      // 清空输入：有历史则展开显示历史，无历史则收起
      this.setData({ results: [], showResults: this.data.history.length > 0, searching: false });
      return;
    }
    this.setData({ showResults: true, searching: true });
    this._timer = setTimeout(() => {
      this.doSearch(key);
    }, 350);
  },

  onSearchBarTap() {
    this.setData({ showResults: true });
  },

  onClearSearch() {
    this.setData({ keyword: '', results: [], showResults: false, searching: false });
  },

  doSearch(key) {
    // 请求序号竞态保护：旧请求晚到直接丢弃
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
          if (seen[it.code]) return; // 同 code 去重
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
    const code = e.currentTarget.dataset.code;
    const name = e.currentTarget.dataset.name;
    if (code && name) {
      util.addHistory(code, name);
      this.setData({ history: util.getHistory() });
    }
    wx.navigateTo({ url: '/pages/detail/detail?code=' + code });
  },

  /** 搜索结果 +/- 自选按钮 */
  onTogglePick(e) {
    const code = e.currentTarget.dataset.code;
    const name = e.currentTarget.dataset.name;
    const idx = e.currentTarget.dataset.index;
    const added = this.data.results[idx] && this.data.results[idx].added;
    if (added) {
      util.removeCode(code);
    } else {
      util.addCode(code);
      if (name) {
        util.addHistory(code, name);
        this.setData({ history: util.getHistory() });
      }
    }
    this.setData({
      ['results[' + idx + '].added']: !added
    });
    this.load(); // 静默刷新自选列表
  },

  onPickHistory(e) {
    const code = e.currentTarget.dataset.code;
    wx.navigateTo({ url: '/pages/detail/detail?code=' + code });
  },

  onClearHistory() {
    util.clearHistory();
    this.setData({ history: [] });
  },

  /** 列表 */

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
          // 当日净值已公布用真实涨幅，否则用估算涨幅
          const today = util.todayStr();
          const dayDate = String(f.lastDayDate || '').replace(/\D/g, '').slice(0, 8);
          const useActual =
            f.lastDayPct !== null &&
            f.lastDayPct !== undefined &&
            dayDate &&
            dayDate === today;
          const pct = useActual ? f.lastDayPct : f.estPct;
          // 编辑模式下轮询刷新保留勾选状态
          const old = this.data.funds.find(function (it) { return it.code === f.code; });
          return {
            code: f.code,
            name: f.name,
            pctText: util.fmtPct(pct),
            cls: util.clsOf(pct),
            selected: old ? !!old.selected : false
          };
        });
        this.setData({ funds: funds, selectedCount: funds.filter(function (it) { return it.selected; }).length });
      })
      .catch((err) => {
        wx.showToast({ title: err.message || '加载失败', icon: 'none', duration: 2500 });
      })
      .then(() => {
        if (isPull) wx.stopPullDownRefresh();
      });
  },

  /** 拖拽排序 */

  onDragTouchStart(e) {
    const idx = e.currentTarget.dataset.index;
    const touch = e.touches[0];
    this._dragStartY = touch.clientY;
    this._dragItemH = 0;
    // 测量单项高度，用于算落点位置
    const q = wx.createSelectorQuery().in(this);
    q.selectAll('.fund').boundingClientRect();
    q.exec((res) => {
      const rects = res && res[0];
      if (rects && rects.length) this._dragItemH = rects[0].height;
    });
    // 起手反馈；同时初始化 dragOverIndex，避免首次 move 重复震
    vibrate('medium');
    this.setData({ dragIndex: idx, dragOverIndex: idx, dragOffsetY: 0 });
  },

  onDragTouchMove(e) {
    const dragIndex = this.data.dragIndex;
    if (dragIndex < 0) return;
    const touch = e.touches[0];
    const dy = touch.clientY - this._dragStartY;
    if (!this._dragItemH) return;
    const funds = this.data.funds;
    const overIndex = Math.max(0, Math.min(funds.length - 1, dragIndex + Math.round(dy / this._dragItemH)));
    const patch = { dragOffsetY: dy };
    if (overIndex !== this.data.dragOverIndex) {
      patch.dragOverIndex = overIndex;
      // 重算每项让位位移：dragIndex 与 overIndex 之间的项整体平移一格
      const h = this._dragItemH;
      patch.funds = funds.map(function (it, i) {
        let s = 0;
        if (dragIndex < overIndex) {
          if (i > dragIndex && i <= overIndex) s = -h;
        } else if (dragIndex > overIndex) {
          if (i >= overIndex && i < dragIndex) s = h;
        }
        return Object.assign({}, it, { shift: s });
      });
      vibrate('light'); // 越过一项边界
    }
    this.setData(patch);
  },

  onDragTouchEnd() {
    const { dragIndex, dragOverIndex, funds } = this.data;
    if (dragIndex < 0 || dragOverIndex < 0 || dragIndex === dragOverIndex) {
      // 复位 shift
      const cleared = funds.map(function (it) { return Object.assign({}, it, { shift: 0 }); });
      this.setData({ funds: cleared, dragIndex: -1, dragOverIndex: -1, dragOffsetY: 0 });
      return;
    }
    const list = funds.slice();
    const moved = list.splice(dragIndex, 1)[0];
    moved.shift = 0;
    list.splice(dragOverIndex, 0, moved);
    // 清掉所有 shift
    list.forEach(function (it) { it.shift = 0; });
    util.setCodes(list.map((f) => f.code));
    this.setData({ funds: list, dragIndex: -1, dragOverIndex: -1, dragOffsetY: 0 });
    vibrate('light'); // 落位
  },

  goDetail(e) {
    const code = e.currentTarget.dataset.code;
    wx.navigateTo({ url: '/pages/detail/detail?code=' + code });
  },

  /** 编辑模式切换 */
  onToggleEdit() {
    const editMode = !this.data.editMode;
    const funds = this.data.funds.map(function (it) {
      return Object.assign({}, it, { selected: editMode ? it.selected : false });
    });
    this.setData({
      editMode: editMode,
      funds: funds,
      selectedCount: funds.filter(function (it) { return it.selected; }).length,
      allSelected: funds.length > 0 && funds.every(function (it) { return it.selected; })
    });
  },

  /** 列表项点击：编辑模式下切换勾选，非编辑模式跳详情 */
  onFundTap(e) {
    if (this.data.editMode) {
      const idx = e.currentTarget.dataset.index;
      const funds = this.data.funds.slice();
      funds[idx] = Object.assign({}, funds[idx], { selected: !funds[idx].selected });
      const selectedCount = funds.filter(function (it) { return it.selected; }).length;
      this.setData({
        ['funds[' + idx + '].selected']: funds[idx].selected,
        selectedCount: selectedCount,
        allSelected: funds.length > 0 && selectedCount === funds.length
      });
    } else {
      this.goDetail(e);
    }
  },

  /** 全选 / 取消全选 */
  onSelectAll() {
    const allSelected = this.data.allSelected;
    const funds = this.data.funds.map(function (it) {
      return Object.assign({}, it, { selected: !allSelected });
    });
    const selectedCount = allSelected ? 0 : funds.length;
    this.setData({
      funds: funds,
      selectedCount: selectedCount,
      allSelected: !allSelected
    });
  },

  /** 删除已勾选的基金 */
  onDeleteSelected() {
    const selected = this.data.funds.filter(function (it) { return it.selected; });
    if (!selected.length) return;
    const codes = selected.map(function (it) { return it.code; });
    const self = this;
    wx.showModal({
      title: '删除确认',
      content: '确定从自选移除 ' + selected.length + ' 只基金？',
      confirmColor: '#e0403f',
      success: function (res) {
        if (!res.confirm) return;
        const remain = util.getCodes().filter(function (c) {
          return codes.indexOf(c) < 0;
        });
        util.setCodes(remain);
        const funds = self.data.funds.filter(function (it) {
          return codes.indexOf(it.code) < 0;
        });
        self.setData({
          funds: funds,
          selectedCount: 0,
          allSelected: false
        });
        if (!funds.length) {
          self.setData({ editMode: false });
        }
        wx.showToast({ title: '已删除', icon: 'success' });
      }
    });
  }
});
