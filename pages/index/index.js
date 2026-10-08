const api = require('../../utils/api.js');
const util = require('../../utils/util.js');
const poller = require('../../utils/poller.js');
const config = require('../../utils/config.js');

/** 拖拽震动：自带节流，避免快速拖动时连续触发 */
function vibrate(type) {
  const now = Date.now();
  if (now - (vibrate._t || 0) < 80) return;
  vibrate._t = now;
  wx.vibrateShort({ type: type, fail: function () {} });
}

/** 行情日期 → YYYYMMDD */
function dayKey(f) {
  return String(f.lastDayDate || '').replace(/\D/g, '').slice(0, 8);
}

/** 当日实际涨幅是否已公布 */
function hasActualPct(f, today) {
  return f.lastDayPct !== null && f.lastDayPct !== undefined && dayKey(f) === today;
}

/** 从接口项中取当日涨幅：已公布就用实际值，否则用估算值 */
function pickPct(f, today) {
  return hasActualPct(f, today) ? f.lastDayPct : f.estPct;
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
    dragOffsetY: 0,
    editMode: false,
    selectedCount: 0,
    allSelected: false,
    pctDateText: '',
    tab: 'hold',
    holdRows: [],
    assetText: '0.00',
    profitText: '0.00',
    profitCls: 'flat',
    totalProfitText: '0.00',
    totalProfitCls: 'flat',
    maxCodeLen: 6,
    addModalShow: false,
    addCode: '',
    addAmount: '',
    addProfit: '',
    addFundName: '',
    addSearching: false,
    addError: '',
    editModeOn: false,
    menuShow: false,
    backupBusy: false
  },

  onLoad() {
    this.setData({ maxCodeLen: config.maxCodeLen });
    this._poller = poller.createPoller({
      interval: config.pollInterval,
      onlyTrading: true,
      guard: () => this.data.funds.length > 0 || this.data.holdRows.length > 0,
      onTick: () => this.load()
    });
    this.setData({ history: util.getHistory() });
    this.load();
  },

  onShow() {
    // 从详情页返回：搜索窗口开则刷新 added 状态，关则刷新自选列表
    if (this.data.showResults) {
      if (this.data.results.length) {
        const codes = util.getCodes();
        const results = this.data.results.map((it) => ({
          code: it.code,
          name: it.name,
          type: it.type,
          added: codes.indexOf(it.code) >= 0
        }));
        this.setData({ results: results });
      }
    } else {
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
    }, config.searchDebounce);
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
    const holdings = util.getHoldings();
    const holdMap = {};
    holdings.forEach(function (h) { holdMap[h.code] = h; });
    // 旧持仓行勾选状态（编辑模式下轮询刷新时保留）
    const oldHoldMap = {};
    this.data.holdRows.forEach(function (r) { oldHoldMap[r.code] = r; });
    // 请求码 = 自选 ∪ 持仓
    const reqCodes = codes.slice();
    holdings.forEach(function (h) {
      if (reqCodes.indexOf(h.code) < 0) reqCodes.push(h.code);
    });

    if (!reqCodes.length) {
      this.setData({ funds: [], holdRows: [], assetText: '0.00', profitText: '0.00', profitCls: 'flat', totalProfitText: '0.00', totalProfitCls: 'flat' });
      if (isPull) wx.stopPullDownRefresh();
      return Promise.resolve();
    }

    return api
      .estimate(reqCodes, false)
      .then((list) => {
        const items = list || [];
        const today = util.todayStr();
        const codeSet = {};
        codes.forEach(function (c) { codeSet[c] = true; });
        const funds = items
          .filter(function (f) { return codeSet[f.code]; })
          .map(function (f) {
            const pct = pickPct(f, today);
            const old = this.data.funds.find(function (it) { return it.code === f.code; });
            return {
              code: f.code,
              name: f.name,
              pctText: util.fmtPct(pct),
              cls: util.clsOf(pct),
              selected: old ? !!old.selected : false
            };
          }.bind(this));
        // 持仓列表 + 资产汇总
        // 账户资产 = Σ(持有金额) + 当日总收益
        // 当真实涨幅公布后，把当天收益固化进持有收益
        let asset = 0;
        let dayProfit = 0;
        let totalProfit = 0;
        const holdRows = [];
        const updMap = {};
        items.forEach(function (f) {
          const h = holdMap[f.code];
          if (!h) return;
          const pct = pickPct(f, today);
          const p = Number(pct);
          const dayVal = h.amount * (Number.isFinite(p) ? p : 0) / 100;
          if (hasActualPct(f, today)) {
            const newProfit = (h.profit || 0) + dayVal;
            updMap[h.code] = Object.assign({}, h, { profit: newProfit });
            totalProfit += newProfit;
          } else {
            dayProfit += dayVal;
            totalProfit += (h.profit || 0);
          }
          asset += h.amount + dayVal;
          holdRows.push({
            code: f.code,
            name: f.name,
            pctText: util.fmtPct(pct),
            cls: util.clsOf(pct),
            profitText: (dayVal >= 0 ? '+' : '') + util.fmtMoney(dayVal),
            profitCls: util.clsOf(dayVal),
            selected: oldHoldMap[f.code] ? !!oldHoldMap[f.code].selected : false
          });
        });
        // 真实涨幅公布后，把更新的持有收益一次性写回 storage
        if (Object.keys(updMap).length) {
          util.setHoldings(util.getHoldings().map(function (h) {
            return updMap[h.code] || h;
          }));
        }
        const withDate = items.find(function (f) { return f.dataDate; });
        const pctDateText = withDate ? util.fmtDataDate(withDate.dataDate) : '';
        this.setData({
          funds: funds,
          pctDateText: pctDateText,
          selectedCount: funds.filter(function (it) { return it.selected; }).length,
          holdRows: holdRows,
          assetText: util.fmtMoney(asset),
          profitText: (dayProfit >= 0 ? '+' : '') + util.fmtMoney(dayProfit),
          profitCls: util.clsOf(dayProfit),
          totalProfitText: (totalProfit >= 0 ? '+' : '') + util.fmtMoney(totalProfit),
          totalProfitCls: util.clsOf(totalProfit)
        });
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
    this._dragOverIndex = idx;
    this.setData({ dragIndex: idx, dragOffsetY: 0 });
  },

  onDragTouchMove(e) {
    const dragIndex = this.data.dragIndex;
    if (dragIndex < 0) return;
    const touch = e.touches[0];
    const dy = touch.clientY - this._dragStartY;
    if (!this._dragItemH) return;
    const key = this.data.tab === 'hold' ? 'holdRows' : 'funds';
    const list = this.data[key];
    const overIndex = Math.max(0, Math.min(list.length - 1, dragIndex + Math.round(dy / this._dragItemH)));
    const patch = { dragOffsetY: dy };
    if (overIndex !== this._dragOverIndex) {
      this._dragOverIndex = overIndex;
      // 重算每项让位位移：dragIndex 与 overIndex 之间的项整体平移一格
      const h = this._dragItemH;
      patch[key] = list.map(function (it, i) {
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
    const dragIndex = this.data.dragIndex;
    const dragOverIndex = this._dragOverIndex;
    const key = this.data.tab === 'hold' ? 'holdRows' : 'funds';
    const list = this.data[key];
    const patch = { dragIndex: -1, dragOffsetY: 0 };
    if (dragIndex < 0 || dragOverIndex < 0 || dragIndex === dragOverIndex) {
      // 复位 shift
      patch[key] = list.map(function (it) { return Object.assign({}, it, { shift: 0 }); });
      this.setData(patch);
      return;
    }
    const reordered = list.slice();
    const moved = reordered.splice(dragIndex, 1)[0];
    moved.shift = 0;
    reordered.splice(dragOverIndex, 0, moved);
    // 清掉所有 shift
    reordered.forEach(function (it) { it.shift = 0; });
    if (key === 'holdRows') {
      // 把新顺序写回持仓 storage（未在列表中的持仓保持原相对顺序排最后）
      const order = {};
      reordered.forEach(function (it, i) { order[it.code] = i; });
      util.setHoldings(
        util.getHoldings().sort(function (a, b) {
          const ia = order[a.code];
          const ib = order[b.code];
          if (ia === undefined && ib === undefined) return 0;
          if (ia === undefined) return 1;
          if (ib === undefined) return -1;
          return ia - ib;
        })
      );
    } else {
      util.setCodes(reordered.map(function (f) { return f.code; }));
    }
    patch[key] = reordered;
    this.setData(patch);
    vibrate('light'); // 落位
  },

  goDetail(e) {
    const code = e.currentTarget.dataset.code;
    wx.navigateTo({ url: '/pages/detail/detail?code=' + code });
  },

  /** 编辑模式切换（自选 / 持有通用）：进入保留勾选，退出清空 */
  onToggleEdit() {
    const editMode = !this.data.editMode;
    const map = function (it) {
      return Object.assign({}, it, { selected: editMode ? it.selected : false });
    };
    const funds = this.data.funds.map(map);
    const holdRows = this.data.holdRows.map(map);
    const cur = this.data.tab === 'hold' ? holdRows : funds;
    this.setData({
      editMode: editMode,
      funds: funds,
      holdRows: holdRows,
      selectedCount: cur.filter(function (it) { return it.selected; }).length,
      allSelected: cur.length > 0 && cur.every(function (it) { return it.selected; })
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

  /** 全选 / 取消全选（当前列表） */
  onSelectAll() {
    const key = this.data.tab === 'hold' ? 'holdRows' : 'funds';
    const allSelected = this.data.allSelected;
    const list = this.data[key].map(function (it) {
      return Object.assign({}, it, { selected: !allSelected });
    });
    const selectedCount = allSelected ? 0 : list.length;
    const patch = {
      selectedCount: selectedCount,
      allSelected: !allSelected
    };
    patch[key] = list;
    this.setData(patch);
  },

  /** 删除已勾选的基金（自选 / 持仓） */
  onDeleteSelected() {
    const isHold = this.data.tab === 'hold';
    const key = isHold ? 'holdRows' : 'funds';
    const selected = this.data[key].filter(function (it) { return it.selected; });
    if (!selected.length) return;
    const codes = selected.map(function (it) { return it.code; });
    const self = this;
    wx.showModal({
      title: '删除确认',
      content: (isHold ? '确定删除 ' : '确定从自选移除 ') + selected.length + ' 只基金？',
      confirmColor: '#e0403f',
      success: function (res) {
        if (!res.confirm) return;
        if (isHold) {
          util.setHoldings(util.getHoldings().filter(function (h) {
            return codes.indexOf(h.code) < 0;
          }));
        } else {
          util.setCodes(util.getCodes().filter(function (c) {
            return codes.indexOf(c) < 0;
          }));
        }
        const remainRows = self.data[key].filter(function (it) {
          return codes.indexOf(it.code) < 0;
        });
        const patch = { selectedCount: 0, allSelected: false };
        patch[key] = remainRows;
        self.setData(patch);
        if (!remainRows.length) {
          self.setData({ editMode: false });
        }
        if (isHold) self.load(); // 刷新资产汇总
        wx.showToast({ title: '已删除', icon: 'success' });
      }
    });
  },

  /** 持仓：tab 切换（切换前退出编辑模式并清空勾选） */
  switchTab(e) {
    const tab = e.currentTarget.dataset.tab;
    if (!tab || tab === this.data.tab) return;
    if (this.data.editMode) this.onToggleEdit();
    this.setData({ tab: tab });
  },

  /** 持有列表项点击：编辑模式下切换勾选，非编辑模式跳详情 */
  onHoldRowTap(e) {
    if (this.data.editMode) {
      const idx = e.currentTarget.dataset.index;
      const holdRows = this.data.holdRows.slice();
      holdRows[idx] = Object.assign({}, holdRows[idx], { selected: !holdRows[idx].selected });
      const selectedCount = holdRows.filter(function (it) { return it.selected; }).length;
      this.setData({
        ['holdRows[' + idx + '].selected']: holdRows[idx].selected,
        selectedCount: selectedCount,
        allSelected: holdRows.length > 0 && selectedCount === holdRows.length
      });
    } else {
      this.goDetail(e);
    }
  },

  /** 长按打开修改弹窗（编辑模式下禁用，避免与勾选冲突） */
  onHoldRowLongPress(e) {
    if (this.data.editMode) return;
    const code = e.currentTarget.dataset.code;
    const h = util.getHoldings().find(function (it) { return it.code === code; });
    if (!h) return;
    this.setData({
      addModalShow: true,
      addCode: h.code,
      addFundName: h.name,
      addAmount: String(h.amount),
      addProfit: String(h.profit || 0),
      addSearching: false,
      addError: '',
      editModeOn: true
    });
  },

  /** 添加持仓：打开弹窗 */
  onAddHolding() {
    this.setData({
      addModalShow: true,
      addCode: '',
      addAmount: '',
      addProfit: '',
      addFundName: '',
      addSearching: false,
      addError: '',
      editModeOn: false
    });
  },

  onAddCodeInput(e) {
    const code = (e.detail.value || '').trim();
    this.setData({ addCode: e.detail.value || '', addFundName: '', addError: '' });
    if (this._addTimer) clearTimeout(this._addTimer);
    if (!code || code.length < config.minCodeLen) {
      this.setData({ addSearching: false });
      return;
    }
    this.setData({ addSearching: true });
    this._addTimer = setTimeout(() => {
      this.lookupAdd(code);
    }, config.searchDebounce);
  },

  lookupAdd(code) {
    const self = this;
    api
      .search(code)
      .then((list) => {
        if (code !== (self.data.addCode || '').trim()) return;
        self.setData({ addSearching: false });
        const hit = (list || []).find(function (it) { return it.code === code; });
        if (hit) {
          self.setData({ addFundName: hit.name, addError: '' });
        } else {
          self.setData({ addFundName: '', addError: '未找到该基金' });
        }
      })
      .catch(() => {
        if (code !== (self.data.addCode || '').trim()) return;
        self.setData({ addSearching: false, addFundName: '', addError: '查询失败' });
      });
  },

  onAddAmountInput(e) {
    this.setData({ addAmount: e.detail.value || '' });
  },

  onAddProfitInput(e) {
    let v = (e.detail.value || '').replace(/[^\d.-]/g, '');
    if (v.indexOf('-') > 0) v = v[0] === '-' ? '-' + v.replace(/-/g, '') : v.replace(/-/g, '');
    const firstDot = v.indexOf('.');
    if (firstDot >= 0) {
      v = v.slice(0, firstDot + 1) + v.slice(firstDot + 1).replace(/\./g, '');
    }
    this.setData({ addProfit: v });
  },

  closeAddModal() {
    this.setData({ addModalShow: false });
  },

  onAddSave() {
    const code = (this.data.addCode || '').trim();
    const name = this.data.addFundName || code;
    const amount = Number(this.data.addAmount);
    const profit = Number(this.data.addProfit || 0);

    if (!code) {
      wx.showToast({ title: '请输入基金代码', icon: 'none' });
      return;
    }
    if (!Number.isFinite(amount) || amount < 0) {
      wx.showToast({ title: '持有金额不合法', icon: 'none' });
      return;
    }
    if (!Number.isFinite(profit)) {
      wx.showToast({ title: '持有收益不合法', icon: 'none' });
      return;
    }

    // 修改模式：金额 0 视为删除
    if (this.data.editModeOn && amount === 0) {
      util.removeHolding(code);
      this.closeAddModal();
      this.load();
      wx.showToast({ title: '已删除', icon: 'success' });
      return;
    }
    if (!this.data.editModeOn && amount <= 0) {
      wx.showToast({ title: '持有金额需大于0', icon: 'none' });
      return;
    }

    util.setHolding(code, name, amount, profit);
    this.closeAddModal();
    this.load();
    wx.showToast({ title: '已保存', icon: 'success' });
  },

  /** 齿轮：打开/关闭设置菜单 */
  onGearTap() {
    this.setData({ menuShow: !this.data.menuShow });
  },

  closeMenu() {
    this.setData({ menuShow: false });
  },

  /** 菜单项：云同步 */
  onMenuSync() {
    this.setData({ menuShow: false });
    this.onOpenBackup();
  },

  /** 菜单项：添加持有基金 */
  onMenuAddHolding() {
    this.setData({ menuShow: false });
    this.onAddHolding();
  },

  /** 菜单项：列表设置（进入当前列表编辑模式） */
  onMenuEdit() {
    this.setData({ menuShow: false });
    this.onToggleEdit();
  },

  /* ============ 云备份 ============ */

  /** 点击 ☁：智能同步 */
  onOpenBackup() {
    if (this.data.backupBusy) return;
    const self = this;
    self.setData({ backupBusy: true });
    wx.cloud.callFunction({
      name: 'backup',
      data: { action: 'info' },
      success(res) {
        const r = res && res.result;
        const remoteTs = (r && r.ok && r.data && r.data.updatedAt) || 0;
        self.decideSync(remoteTs);
      },
      fail() {
        self.setData({ backupBusy: false });
        wx.showToast({ title: '云同步失败', icon: 'none' });
      }
    });
  },

  decideSync(remoteTs) {
    const codes = util.getCodes();
    const holdings = util.getHoldings();
    const hasLocal = codes.length > 0 || holdings.length > 0;

    if (!hasLocal) {
      this.doRestore();
      return;
    }
    if (!remoteTs) {
      this.doBackup(codes, holdings);
      return;
    }

    const localNewer = util.getLocalDirtyTs() > util.getBackupTs();
    const remoteNewer = remoteTs > util.getBackupTs();

    if (localNewer) {
      this.doBackup(codes, holdings);
    } else if (remoteNewer) {
      this.doRestore();
    } else {
      this.setData({ backupBusy: false });
      wx.showToast({ title: '数据已是最新', icon: 'none' });
    }
  },

  doBackup(codes, holdings) {
    const self = this;
    wx.cloud.callFunction({
      name: 'backup',
      data: { action: 'upload', codes: codes, holdings: holdings },
      success(res) {
        const r = res && res.result;
        if (r && r.ok && r.data) {
          util.setBackupTs(r.data.updatedAt);
          util.touchLocalDirty(r.data.updatedAt);
          wx.showToast({ title: '已同步到云端', icon: 'success' });
        } else {
          wx.showToast({ title: '云同步失败', icon: 'none' });
        }
      },
      fail() {
        wx.showToast({ title: '云同步失败', icon: 'none' });
      },
      complete() {
        self.setData({ backupBusy: false });
      }
    });
  },

  doRestore() {
    const self = this;
    wx.cloud.callFunction({
      name: 'backup',
      data: { action: 'pull' },
      success(res) {
        const r = res && res.result;
        if (!r || !r.ok) {
          wx.showToast({ title: '云同步失败', icon: 'none' });
          return;
        }
        const data = r.data;
        if (!data || (!(data.codes && data.codes.length) && !(data.holdings && data.holdings.length))) {
          wx.showToast({ title: '云端暂无数据', icon: 'none' });
          return;
        }
        util.setCodesSilent(data.codes || []);
        util.setHoldingsSilent(data.holdings || []);
        const ts = data.updatedAt || Date.now();
        util.setBackupTs(ts);
        util.touchLocalDirty(ts);
        self.load();
        wx.showToast({ title: '已从云端恢复', icon: 'success' });
      },
      fail() {
        wx.showToast({ title: '云同步失败', icon: 'none' });
      },
      complete() {
        self.setData({ backupBusy: false });
      }
    });
  }
});
