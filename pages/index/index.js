const api = require('../../utils/api.js');
const util = require('../../utils/util.js');
const poller = require('../../utils/poller.js');
const config = require('../../utils/config.js');

/** 拖拽震动（80ms 节流，避免快速拖动连续触发） */
function vibrate(type) {
  const now = Date.now();
  if (now - (vibrate._t || 0) < 80) return;
  vibrate._t = now;
  wx.vibrateShort({ type: type, fail: function () {} });
}

/** 净值日字符串 → YYYYMMDD */
function navKey(s) {
  return String(s || '').replace(/\D/g, '').slice(0, 8);
}

/**
 * 真实涨幅是否已公布：
 * 1. 最新净值日覆盖行情日（收盘后/周末行情停留时段）；
 * 2. 9:30 前行情已翻到今日但未开盘（估算恒为 0），已公布净值日即上一交易日；
 * 3. 无行情日（债券型等）——当日净值公布后才切换
 */
function hasActualPct(f, today) {
  if (f.lastDayPct === null || f.lastDayPct === undefined) return false;
  const navDay = navKey(f.lastDayDate);
  const quoteDay = navKey(f.dataDate);
  if (quoteDay && navDay >= quoteDay) return true;
  if (navDay && navDay < today && util.beforeOpen() && (!quoteDay || quoteDay === today)) return true;
  return !quoteDay && navDay === today;
}

/** 取最新涨幅：已公布用实际值，否则用估算值 */
function pickPct(f, today) {
  return hasActualPct(f, today) ? f.lastDayPct : f.estPct;
}

/** 未结转的净值日（date > foldDate 且已披露），按日期升序，用于补结转漏掉的交易日 */
function missedNavDays(f, foldDate) {
  const out = [];
  (f.navDays || []).forEach(function (d) {
    const k = navKey(d.date);
    const pct = Number(d.pct);
    if (!k || k <= foldDate || !Number.isFinite(pct)) return;
    out.push({ day: k, pct: pct });
  });
  out.sort(function (a, b) { return a.day < b.day ? -1 : 1; });
  return out;
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
    this.setData({ maxCodeLen: config.maxCodeLen, history: util.getHistory() });
    this._poller = poller.createPoller({
      interval: config.pollInterval,
      onlyTrading: true,
      guard: () => this.data.funds.length > 0 || this.data.holdRows.length > 0,
      onTick: () => this.load()
    });
    this.load();
  },

  onShow() {

    // 从详情页返回：搜索窗口开则刷新 added 状态，关则刷新自选列表
    if (this.data.showResults) {
      if (this.data.results.length) {
        const codes = util.getCodes();
        this.setData({
          results: this.data.results.map((it) => ({
            code: it.code,
            name: it.name,
            type: it.type,
            added: codes.indexOf(it.code) >= 0
          }))
        });
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

  onPageTap() {
    if (this.data.showResults) {
      this.setData({ showResults: false, searching: false });
      this.load();
    }
  },

  /** 空操作，用于 catchtap 阻止冒泡 */
  noop() {},

  /* ---------- 搜索 ---------- */
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
    this._timer = setTimeout(() => this.doSearch(key), config.searchDebounce);
  },

  onSearchBarTap() {
    this.setData({ showResults: true });
  },

  onClearSearch() {
    this.setData({ keyword: '', results: [], showResults: false, searching: false });
  },

  doSearch(key) {
    const seq = (this._seq || 0) + 1; // 竞态保护：旧请求晚到直接丢弃
    this._seq = seq;
    api
      .search(key)
      .then((list) => {
        if (seq !== this._seq) return;
        const codes = util.getCodes();
        const seen = {};
        const results = [];
        (list || []).forEach((it) => {
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
    const code = e.currentTarget.dataset.code;
    const name = e.currentTarget.dataset.name;
    if (code && name) {
      util.addHistory(code, name);
      this.setData({ history: util.getHistory() });
    }
    wx.navigateTo({ url: '/pages/detail/detail?code=' + code });
  },

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
    this.setData({ ['results[' + idx + '].added']: !added });
    this.load();
  },

  onPickHistory(e) {
    wx.navigateTo({ url: '/pages/detail/detail?code=' + e.currentTarget.dataset.code });
  },

  onClearHistory() {
    util.clearHistory();
    this.setData({ history: [] });
  },

  /* ---------- 列表 ---------- */
  load(isPull) {
    const codes = util.getCodes();
    const holdings = util.getHoldings();
    const holdMap = {};
    holdings.forEach(function (h) { holdMap[h.code] = h; });

    // 编辑模式下轮询刷新时保留旧勾选状态
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
          .map((f) => {
            const pct = pickPct(f, today);
            const old = this.data.funds.find((it) => it.code === f.code);
            return {
              code: f.code,
              name: f.name,
              pctText: util.fmtPct(pct),
              cls: util.clsOf(pct),
              selected: old ? !!old.selected : false
            };
          });

        // 持有收益 = 截至 foldDate 的累计收益（当日净值公布后结转，每个净值日只结转一次）
        // 总资产 = Σ(持有金额) + 未结转的当日收益
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
          const amount = Number(h.amount) || 0;
          const oldProfit = Number(h.profit) || 0;
          const dayVal = (amount * (Number.isFinite(p) ? p : 0)) / 100;
          const navDay = navKey(f.lastDayDate);
          const actualToday = hasActualPct(f, today);

          let curAmount = amount;
          let curProfit = oldProfit;
          let foldDate = h.foldDate || '';
          let foldedToday = false;

          // 首次登记：录入的持有收益即视为截至当前净值日
          if (!foldDate) {

            foldDate = navDay;
            foldedToday = actualToday;
          } else {

            // 补齐漏结转的交易日（收益与金额同步推进，否则次日基数会错）
            missedNavDays(f, foldDate).forEach(function (d) {
              const gain = (curAmount * d.pct) / 100;
              curAmount += gain;
              curProfit += gain;
              foldDate = d.day;
            });
            foldedToday = actualToday && foldDate === navDay;
          }

          // 已结转进持有收益的当日收益不再重复计入
          const pendingDay = foldedToday ? 0 : dayVal;

          if (foldDate !== (h.foldDate || '') || curAmount !== amount || curProfit !== oldProfit) {
            updMap[h.code] = Object.assign({}, h, { amount: curAmount, profit: curProfit, foldDate: foldDate });
          }
          totalProfit += curProfit;
          dayProfit += pendingDay;
          asset += curAmount + pendingDay;
          holdRows.push({
            code: f.code,
            name: f.name,
            pctText: util.fmtPct(pct),
            cls: util.clsOf(pct),
            profitText: (pendingDay >= 0 ? '+' : '') + util.fmtMoney(pendingDay),
            profitCls: util.clsOf(pendingDay),
            selected: oldHoldMap[f.code] ? !!oldHoldMap[f.code].selected : false
          });
        });

        // 真实涨幅公布后把更新的持有收益写回 storage
        if (Object.keys(updMap).length) {
          util.setHoldings(util.getHoldings().map((h) => updMap[h.code] || h));
        }

        // 表头日期：展示真实涨幅时取其净值日（9:30 前为上一交易日），否则取估算行情日
        const actualItem = items.find(function (f) { return hasActualPct(f, today); });
        const dateItem = actualItem || items.find(function (f) { return f.dataDate; });
        const pctDateText = dateItem
          ? util.fmtDataDate(actualItem ? actualItem.lastDayDate : dateItem.dataDate)
          : '';
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

  /* ---------- 拖拽排序 ---------- */
  onDragTouchStart(e) {
    const idx = e.currentTarget.dataset.index;
    this._dragStartY = e.touches[0].clientY;
    this._dragItemH = 0;
    wx.createSelectorQuery().in(this).selectAll('.fund').boundingClientRect().exec((res) => {
      const rects = res && res[0];
      if (rects && rects.length) this._dragItemH = rects[0].height;
    });
    vibrate('medium');
    this._dragOverIndex = idx;
    this.setData({ dragIndex: idx, dragOffsetY: 0 });
  },

  onDragTouchMove(e) {
    const dragIndex = this.data.dragIndex;
    if (dragIndex < 0) return;
    const dy = e.touches[0].clientY - this._dragStartY;
    if (!this._dragItemH) return;
    const key = this.data.tab === 'hold' ? 'holdRows' : 'funds';
    const list = this.data[key];
    const overIndex = Math.max(0, Math.min(list.length - 1, dragIndex + Math.round(dy / this._dragItemH)));
    const patch = { dragOffsetY: dy };
    if (overIndex !== this._dragOverIndex) {
      this._dragOverIndex = overIndex;

      const h = this._dragItemH;
      // dragIndex 与 overIndex 之间的项整体平移一格让位
      patch[key] = list.map(function (it, i) {
        let s = 0;
        if (dragIndex < overIndex) {
          if (i > dragIndex && i <= overIndex) s = -h;
        } else if (dragIndex > overIndex) {
          if (i >= overIndex && i < dragIndex) s = h;
        }
        return Object.assign({}, it, { shift: s });
      });
      vibrate('light');
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
      patch[key] = list.map(function (it) { return Object.assign({}, it, { shift: 0 }); });
      this.setData(patch);
      return;
    }
    const reordered = list.slice();
    const moved = reordered.splice(dragIndex, 1)[0];
    reordered.splice(dragOverIndex, 0, moved);
    reordered.forEach(function (it) { it.shift = 0; });
    // 新顺序写回持仓 storage（未在列表中的持仓排最后，保持原相对顺序）
    if (key === 'holdRows') {

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
    vibrate('light');
  },

  goDetail(e) {
    wx.navigateTo({ url: '/pages/detail/detail?code=' + e.currentTarget.dataset.code });
  },

  /** 切换编辑模式（自选/持有通用）：进入保留勾选，退出清空 */
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

  /** 列表项点击：编辑模式切换勾选，否则跳详情 */
  onFundTap(e) {
    this.toggleSelect(e, 'funds');
  },

  onHoldRowTap(e) {
    this.toggleSelect(e, 'holdRows');
  },

  toggleSelect(e, key) {
    if (!this.data.editMode) return this.goDetail(e);
    const idx = e.currentTarget.dataset.index;
    const list = this.data[key].slice();
    list[idx] = Object.assign({}, list[idx], { selected: !list[idx].selected });
    const selectedCount = list.filter(function (it) { return it.selected; }).length;
    this.setData({
      [key + '[' + idx + '].selected']: list[idx].selected,
      selectedCount: selectedCount,
      allSelected: list.length > 0 && selectedCount === list.length
    });
  },

  /** 全选/取消全选（当前列表） */
  onSelectAll() {
    const key = this.data.tab === 'hold' ? 'holdRows' : 'funds';
    const allSelected = this.data.allSelected;
    const list = this.data[key].map(function (it) {
      return Object.assign({}, it, { selected: !allSelected });
    });
    const patch = {
      selectedCount: allSelected ? 0 : list.length,
      allSelected: !allSelected
    };
    patch[key] = list;
    this.setData(patch);
  },

  /** 删除已勾选的基金（自选/持仓） */
  onDeleteSelected() {
    const isHold = this.data.tab === 'hold';
    const key = isHold ? 'holdRows' : 'funds';
    const selected = this.data[key].filter(function (it) { return it.selected; });
    if (!selected.length) return;
    const codes = selected.map(function (it) { return it.code; });
    wx.showModal({
      title: '删除确认',
      content: (isHold ? '确定删除 ' : '确定从自选移除 ') + selected.length + ' 只基金？',
      confirmColor: '#e0403f',
      success: (res) => {
        if (!res.confirm) return;
        if (isHold) {
          util.setHoldings(util.getHoldings().filter(function (h) { return codes.indexOf(h.code) < 0; }));
        } else {
          util.setCodes(util.getCodes().filter(function (c) { return codes.indexOf(c) < 0; }));
        }
        const remainRows = this.data[key].filter(function (it) { return codes.indexOf(it.code) < 0; });
        const patch = { selectedCount: 0, allSelected: false };
        patch[key] = remainRows;
        this.setData(patch);
        if (!remainRows.length) this.setData({ editMode: false });
        if (isHold) this.load(); // 刷新资产汇总
        wx.showToast({ title: '已删除', icon: 'success' });
      }
    });
  },

  /** tab 切换（切换前退出编辑模式并清空勾选） */
  switchTab(e) {
    const tab = e.currentTarget.dataset.tab;
    if (!tab || tab === this.data.tab) return;
    if (this.data.editMode) this.onToggleEdit();
    this.setData({ tab: tab });
  },

  /* ---------- 持仓弹窗 ---------- */
  /** 长按打开修改弹窗（编辑模式下禁用，避免与勾选冲突） */
  onHoldRowLongPress(e) {
    if (this.data.editMode) return;
    const h = util.getHoldings().find((it) => it.code === e.currentTarget.dataset.code);
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
    this._addTimer = setTimeout(() => this.lookupAdd(code), config.searchDebounce);
  },

  lookupAdd(code) {
    api
      .search(code)
      .then((list) => {
        if (code !== (this.data.addCode || '').trim()) return;
        this.setData({ addSearching: false });
        const hit = (list || []).find(function (it) { return it.code === code; });
        this.setData(hit ? { addFundName: hit.name, addError: '' } : { addFundName: '', addError: '未找到该基金' });
      })
      .catch(() => {
        if (code !== (this.data.addCode || '').trim()) return;
        this.setData({ addSearching: false, addFundName: '', addError: '查询失败' });
      });
  },

  onAddAmountInput(e) {
    this.setData({ addAmount: e.detail.value || '' });
  },

  onAddProfitInput(e) {
    let v = (e.detail.value || '').replace(/[^\d.-]/g, '');
    if (v.indexOf('-') > 0) v = v[0] === '-' ? '-' + v.replace(/-/g, '') : v.replace(/-/g, '');
    const dot = v.indexOf('.');
    if (dot >= 0) v = v.slice(0, dot + 1) + v.slice(dot + 1).replace(/\./g, '');
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

    if (!code) return wx.showToast({ title: '请输入基金代码', icon: 'none' });
    if (!Number.isFinite(amount) || amount < 0) return wx.showToast({ title: '持有金额不合法', icon: 'none' });
    if (!Number.isFinite(profit)) return wx.showToast({ title: '持有收益不合法', icon: 'none' });

    // 修改模式：金额 0 视为删除
    if (this.data.editModeOn && amount === 0) {
      util.removeHolding(code);
      this.closeAddModal();
      this.load();
      wx.showToast({ title: '已删除', icon: 'success' });
      return;
    }
    if (!this.data.editModeOn && amount <= 0) return wx.showToast({ title: '持有金额需大于0', icon: 'none' });

    util.setHolding(code, name, amount, profit);
    this.closeAddModal();
    this.load();
    wx.showToast({ title: '已保存', icon: 'success' });
  },

  /* ---------- 菜单 ---------- */
  onGearTap() {
    this.setData({ menuShow: !this.data.menuShow });
  },

  closeMenu() {
    this.setData({ menuShow: false });
  },

  onMenuSync() {
    this.setData({ menuShow: false });
    this.onOpenBackup();
  },

  onMenuAddHolding() {
    this.setData({ menuShow: false });
    this.onAddHolding();
  },

  onMenuEdit() {
    this.setData({ menuShow: false });
    this.onToggleEdit();
  },

  /* ---------- 云备份 ---------- */
  /** 点击 ☁：智能同步 */
  onOpenBackup() {
    if (this.data.backupBusy) return;
    this.setData({ backupBusy: true });
    wx.cloud.callFunction({
      name: 'backup',
      data: { action: 'info' },
      success: (res) => {
        const r = res && res.result;
        this.decideSync((r && r.ok && r.data && r.data.updatedAt) || 0);
      },
      fail: () => {
        this.setData({ backupBusy: false });
        wx.showToast({ title: '云同步失败', icon: 'none' });
      }
    });
  },

  decideSync(remoteTs) {
    const codes = util.getCodes();
    const holdings = util.getHoldings();
    const hasLocal = codes.length > 0 || holdings.length > 0;

    if (!hasLocal) return this.doRestore();
    if (!remoteTs) return this.doBackup(codes, holdings);

    const localNewer = util.getLocalDirtyTs() > util.getBackupTs();
    const remoteNewer = remoteTs > util.getBackupTs();
    if (localNewer) this.doBackup(codes, holdings);
    else if (remoteNewer) this.doRestore();
    else {
      this.setData({ backupBusy: false });
      wx.showToast({ title: '数据已是最新', icon: 'none' });
    }
  },

  doBackup(codes, holdings) {
    wx.cloud.callFunction({
      name: 'backup',
      data: { action: 'upload', codes: codes, holdings: holdings },
      success: (res) => {
        const r = res && res.result;
        if (r && r.ok && r.data) {
          util.setBackupTs(r.data.updatedAt);
          util.touchLocalDirty(r.data.updatedAt);
          wx.showToast({ title: '已同步到云端', icon: 'success' });
        } else {
          wx.showToast({ title: '云同步失败', icon: 'none' });
        }
      },
      fail: () => wx.showToast({ title: '云同步失败', icon: 'none' }),
      complete: () => this.setData({ backupBusy: false })
    });
  },

  doRestore() {
    wx.cloud.callFunction({
      name: 'backup',
      data: { action: 'pull' },
      success: (res) => {
        const r = res && res.result;
        if (!r || !r.ok) return wx.showToast({ title: '云同步失败', icon: 'none' });
        const data = r.data;
        if (!data || (!(data.codes && data.codes.length) && !(data.holdings && data.holdings.length))) {
          return wx.showToast({ title: '云端暂无数据', icon: 'none' });
        }
        util.setCodesSilent(data.codes || []);
        util.setHoldingsSilent(data.holdings || []);
        const ts = data.updatedAt || Date.now();
        util.setBackupTs(ts);
        util.touchLocalDirty(ts);
        this.load();
        wx.showToast({ title: '已从云端恢复', icon: 'success' });
      },
      fail: () => wx.showToast({ title: '云同步失败', icon: 'none' }),
      complete: () => this.setData({ backupBusy: false })
    });
  }
});
