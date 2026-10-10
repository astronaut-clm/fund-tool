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

/** 净值/行情日字符串 → YYYYMMDD */
function navKey(s) {
  const t = String(s || '').replace(/\D/g, '');
  return t.length >= 8 ? t.slice(0, 8) : '';
}

function roundMoney(n) {
  return Number(n.toFixed(2));
}

/** 当前没有今日有效行情时，使用最近已披露的净值日 */
function useLastNav(f, today) {
  const now = new Date();
  const quoteDay = navKey(f.dataDate);
  return util.beforeOpen(now) || now.getDay() === 0 || now.getDay() === 6 || quoteDay !== today;
}

/** 已披露净值覆盖行情日，或今日尚无有效行情 */
function hasActualPct(f, today) {
  const navDay = navKey(f.lastDayDate);
  if (!navDay || f.lastDayPct === null || f.lastDayPct === undefined) return false;
  const quoteDay = navKey(f.dataDate);
  return (quoteDay && navDay >= quoteDay) || useLastNav(f, today);
}

/** 取当前展示涨幅；休市且没有已披露净值时不沿用过期估算 */
function pickPct(f, today) {
  if (hasActualPct(f, today)) return f.lastDayPct;
  return useLastNav(f, today) ? null : f.estPct;
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
    holdingsEdit: false,
    holdingsDraft: [],
    holdingsError: '',
    holdingAddCode: '',
    holdingAddError: '',
    holdingAddSearching: false,
    selectedCount: 0,
    pctDateText: '',
    tab: 'hold',
    holdRows: [],
    assetText: '0.00',
    profitText: '0.00',
    profitLabel: '当日收益',
    profitCls: 'flat',
    totalProfitText: '0.00',
    totalProfitCls: 'flat',
    menuShow: false,
    backupBusy: false
  },

  onLoad() {
    this.setData({ history: util.getHistory() });
    if (wx.showShareMenu) {
      wx.showShareMenu({ menus: ['shareAppMessage'] });
    }
    this._poller = poller.createPoller({
      interval: config.pollInterval,
      onlyTrading: true,
      guard: () => !this.data.holdingsEdit && (this.data.funds.length > 0 || this.data.holdRows.length > 0),
      onTick: () => this.load()
    });
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
    if (this.data.holdingsEdit) this.cancelHoldingsEdit();
    this._tabTouch = null;
    if (this._timer) clearTimeout(this._timer);
    this._seq = (this._seq || 0) + 1;
    this._loadSeq = (this._loadSeq || 0) + 1;
    this.setData({ searching: false });
  },

  onUnload() {
    this.onHide();
  },

  onPullDownRefresh() {
    this.load(true);
  },

  /** 右上角分享 */
  onShareAppMessage() {
    return {
      title: '投基工具 · 基金估值实时查看',
      path: '/pages/index/index'
    };
  },

  onPageTap() {
    if (this.data.showResults) {
      if (this._timer) clearTimeout(this._timer);
      this._seq = (this._seq || 0) + 1;
      this.setData({ showResults: false, searching: false });
      this.load();
    }
  },

  /** 空操作，用于 catchtap 阻止冒泡 */
  noop() {},

  /* ---------- 搜索 ---------- */
  onInput(e) {
    const key = (e.detail.value || '').trim();
    this.setData({ keyword: e.detail.value || '', results: [] });
    if (this._timer) clearTimeout(this._timer);
    this._seq = (this._seq || 0) + 1;
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
    if (this._timer) clearTimeout(this._timer);
    this._seq = (this._seq || 0) + 1;
    this.setData({ keyword: '', results: [], showResults: false, searching: false });
  },

  doSearch(key) {
    const seq = this._seq;
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
    if (this.data.holdingsEdit) {
      if (isPull) wx.stopPullDownRefresh();
      return Promise.resolve();
    }
    const seq = (this._loadSeq || 0) + 1;
    this._loadSeq = seq;
    const codes = util.getCodes();
    const holdings = util.getHoldings();

    const reqCodes = codes.slice();
    const reqCodeSet = new Set(reqCodes);
    holdings.forEach(function (h) {
      if (!reqCodeSet.has(h.code)) {
        reqCodeSet.add(h.code);
        reqCodes.push(h.code);
      }
    });

    if (!reqCodes.length) {
      this.setData({
        funds: [], holdRows: [], pctDateText: '', selectedCount: 0,
        assetText: '0.00', profitText: '0.00', profitLabel: '当日收益', profitCls: 'flat', totalProfitText: '0.00', totalProfitCls: 'flat'
      });
      if (isPull) wx.stopPullDownRefresh();
      return Promise.resolve();
    }

    return Promise.all(
      Array.from({ length: Math.ceil(reqCodes.length / 20) }, (_, i) =>
        api.estimate(reqCodes.slice(i * 20, (i + 1) * 20), false)
      )
    )
      .then((batches) => {
        if (seq !== this._loadSeq) return;
        const items = batches.reduce((all, batch) => all.concat(batch || []), []);
        const oldHoldMap = {};
        this.data.holdRows.forEach(function (r) { oldHoldMap[r.code] = r; });
        const oldFundMap = {};
        this.data.funds.forEach(function (r) { oldFundMap[r.code] = r; });
        const today = util.todayStr();
        const byCode = new Map(items.map(function (f) { return [f.code, f]; }));
        const funds = codes
          .map(function (code) { return byCode.get(code); })
          .filter(Boolean)
          .map((f) => {
            const pct = pickPct(f, today);
            const old = oldFundMap[f.code];
            return {
              code: f.code,
              name: f.name,
              pctText: util.fmtPct(pct),
              cls: util.clsOf(pct),
              selected: old ? !!old.selected : false
            };
          });

        // 持有收益 = 截至 foldDate 的累计收益；总资产只加尚未结转的收益
        let asset = 0;
        let dayProfit = 0;
        let totalProfit = 0;
        let hasDayProfit = false;
        let showingPrevious = false;
        let olderThanYesterday = false;
        const previousDate = new Date();
        previousDate.setDate(previousDate.getDate() - 1);
        const yesterday = util.todayStr(previousDate);
        const holdRows = [];
        const updMap = {};
        holdings.forEach(function (h) {
          const f = byCode.get(h.code);
          if (!f) return;
          const pct = pickPct(f, today);
          const hasPct = pct !== null && pct !== undefined && Number.isFinite(Number(pct));
          const p = hasPct ? Number(pct) : 0;
          const amount = roundMoney(Number(h.amount) || 0);
          const oldProfit = roundMoney(Number(h.profit) || 0);
          const dayVal = roundMoney((amount * p) / 100);
          const navDay = navKey(f.lastDayDate);
          const actualToday = hasActualPct(f, today);
          if (actualToday && navDay < today) showingPrevious = true;
          if (actualToday && navDay < yesterday) olderThanYesterday = true;
          if (!actualToday && useLastNav(f, today)) olderThanYesterday = true;

          let curAmount = amount;
          let curProfit = oldProfit;
          let foldDate = h.foldDate || '';
          let foldedToday = false;
          let lastNavGain = null;

          // 首次登记：录入的持有收益即视为截至当前净值日
          if (!foldDate) {
            foldDate = navDay;
            foldedToday = actualToday;
          } else {
            // 补齐漏结转的交易日（收益与金额同步推进，否则次日基数会错）
            missedNavDays(f, foldDate).forEach(function (d) {
              const gain = roundMoney((curAmount * d.pct) / 100);
              curAmount = roundMoney(curAmount + gain);
              curProfit = roundMoney(curProfit + gain);
              foldDate = d.day;
              if (d.day === navDay) lastNavGain = gain;
            });
            foldedToday = actualToday && foldDate === navDay;
          }

          // 展示已结转的净值日收益，但不再次加入总资产
          const pendingDay = foldedToday ? 0 : dayVal;
          const shownDay = !hasPct ? null : !foldedToday ? pendingDay
            : !h.foldDate ? null
              : lastNavGain !== null ? lastNavGain
                : p > -100 ? roundMoney((curAmount * p) / (100 + p)) : null;

          if (foldDate !== (h.foldDate || '') || curAmount !== Number(h.amount) || curProfit !== Number(h.profit)) {
            updMap[h.code] = Object.assign({}, h, { amount: curAmount, profit: curProfit, foldDate: foldDate });
          }
          totalProfit += curProfit;
          if (shownDay !== null) {
            dayProfit += shownDay;
            hasDayProfit = true;
          }
          asset += curAmount + pendingDay;
          holdRows.push({
            code: f.code,
            name: f.name,
            pctText: util.fmtPct(pct),
            cls: util.clsOf(pct),
            profitText: shownDay === null ? '--' : (shownDay >= 0 ? '+' : '') + util.fmtMoney(shownDay),
            profitCls: util.clsOf(shownDay),
            selected: oldHoldMap[f.code] ? !!oldHoldMap[f.code].selected : false
          });
        });

        // 真实涨幅公布后把更新的持有收益写回 storage
        if (Object.keys(updMap).length) {
          util.setHoldings(util.getHoldings().map((h) => updMap[h.code] || h));
        }

        // 表头日期：按列表多数行的展示口径决定（净值日 / 行情日），
        // 避免某只净值日或行情日滞后的基金（QDII、港股等）单独绑架整个表头
        let actualCnt = 0;
        let estCnt = 0;
        let navMax = '';
        let quoteMax = '';
        items.forEach(function (f) {
          const navDay = navKey(f.lastDayDate);
          const qDay = navKey(f.dataDate);
          if (hasActualPct(f, today)) {
            actualCnt++;
            if (navDay > navMax) navMax = navDay;
          } else {
            estCnt++;
            if (qDay > quoteMax) quoteMax = qDay;
          }
        });
        const pctDateText = actualCnt > estCnt
          ? util.fmtDataDate(navMax)
          : util.fmtDataDate(quoteMax || navMax);
        const selectedRows = this.data.tab === 'hold' ? holdRows : funds;
        this.setData({
          funds: funds,
          pctDateText: pctDateText,
          selectedCount: selectedRows.filter(function (it) { return it.selected; }).length,
          holdRows: holdRows,
          assetText: util.fmtMoney(asset),
          profitLabel: olderThanYesterday ? '最近收益' : showingPrevious ? '昨日收益' : '当日收益',
          profitText: hasDayProfit ? (dayProfit >= 0 ? '+' : '') + util.fmtMoney(dayProfit) : '--',
          profitCls: util.clsOf(dayProfit),
          totalProfitText: (totalProfit >= 0 ? '+' : '') + util.fmtMoney(totalProfit),
          totalProfitCls: util.clsOf(totalProfit)
        });
      })
      .catch((err) => {
        if (seq === this._loadSeq) wx.showToast({ title: err.message || '加载失败', icon: 'none', duration: 2500 });
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
    if (this.data.holdingsEdit) return;
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
      selectedCount: cur.filter(function (it) { return it.selected; }).length
    });
  },

  /** 列表项点击：编辑模式切换勾选，否则跳详情 */
  onFundTap(e) {
    this.toggleSelect(e, 'funds');
  },

  onHoldRowTap(e) {
    this.toggleSelect(e, 'holdRows');
  },

  onFundLongPress() {
    this.enterListEdit();
  },

  onHoldRowLongPress() {
    this.enterListEdit();
  },

  enterListEdit() {
    if (this.data.editMode || this.data.holdingsEdit) return;
    this._ignoreRowTapUntil = Date.now() + 500;
    this.setData({ menuShow: false });
    this.onToggleEdit();
  },

  toggleSelect(e, key) {
    if (Date.now() < (this._ignoreRowTapUntil || 0)) return;
    if (!this.data.editMode) return this.goDetail(e);
    const idx = e.currentTarget.dataset.index;
    const list = this.data[key].slice();
    list[idx] = Object.assign({}, list[idx], { selected: !list[idx].selected });
    const selectedCount = list.filter(function (it) { return it.selected; }).length;
    this.setData({
      [key + '[' + idx + '].selected']: list[idx].selected,
      selectedCount: selectedCount
    });
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
      content: (isHold ? '确定从持仓删除 ' : '确定从自选移除 ') + selected.length + ' 只基金？',
      confirmColor: '#e0403f',
      success: (res) => {
        if (!res.confirm) return;
        if (isHold) {
          util.setHoldings(util.getHoldings().filter(function (h) { return codes.indexOf(h.code) < 0; }));
        } else {
          util.setCodes(util.getCodes().filter(function (c) { return codes.indexOf(c) < 0; }));
        }
        const remainRows = this.data[key].filter(function (it) { return codes.indexOf(it.code) < 0; });
        const patch = { selectedCount: 0 };
        patch[key] = remainRows;
        this.setData(patch);
        if (!remainRows.length) this.setData({ editMode: false });
        this.load();
        wx.showToast({ title: '已删除', icon: 'success' });
      }
    });
  },

  onTabTouchStart(e) {
    this._tabTouch = null;
    if (this.data.showResults || this.data.editMode || this.data.holdingsEdit || this.data.menuShow ||
        !e.touches || e.touches.length !== 1) return;
    const touch = e.touches[0];
    this._tabTouch = { x: touch.pageX, y: touch.pageY };
  },

  onTabTouchMove(e) {
    if (this._tabTouch && (!e.touches || e.touches.length !== 1)) this._tabTouch = null;
  },

  onTabTouchEnd(e) {
    const start = this._tabTouch;
    this._tabTouch = null;
    if (!start || this.data.showResults || this.data.editMode || this.data.holdingsEdit || this.data.menuShow ||
        !e.changedTouches || e.changedTouches.length !== 1) return;
    const touch = e.changedTouches[0];
    const dx = touch.pageX - start.x;
    const dy = touch.pageY - start.y;
    if (Math.abs(dx) < 80 || Math.abs(dx) < Math.abs(dy) * 1.5) return;
    const tab = dx < 0 ? 'watch' : 'hold';
    if (tab === this.data.tab) return;
    this._ignoreRowTapUntil = Date.now() + 500;
    this.switchTab({ currentTarget: { dataset: { tab: tab } } });
  },

  onTabTouchCancel() {
    this._tabTouch = null;
  },

  /** tab 切换（切换前退出编辑模式并清空勾选） */
  switchTab(e) {
    const tab = e.currentTarget.dataset.tab;
    if (!tab || tab === this.data.tab) return;
    this._tabTouch = null;
    if (this.data.holdingsEdit) this.cancelHoldingsEdit();
    if (this.data.editMode) this.onToggleEdit();
    const rows = tab === 'hold' ? this.data.holdRows : this.data.funds;
    const selectedCount = rows.filter(function (it) { return it.selected; }).length;
    this.setData({ tab: tab, selectedCount: selectedCount, menuShow: false });
  },

  /* ---------- 修改持仓 ---------- */
  onMenuEditHoldings() {
    const holdings = util.getHoldings();
    this.setData({ menuShow: false });
    if (this._holdingAddTimer) clearTimeout(this._holdingAddTimer);
    this._holdingAddSeq = (this._holdingAddSeq || 0) + 1;
    this._loadSeq = (this._loadSeq || 0) + 1;
    this.setData({
      tab: 'hold',
      editMode: false,
      selectedCount: 0,
      holdingsEdit: true,
      holdingsError: '',
      holdingAddCode: '',
      holdingAddError: '',
      holdingAddSearching: false,
      holdingsDraft: holdings.map(function (h) {
        return {
          code: h.code, name: h.name || h.code,
          amount: roundMoney(Number(h.amount) || 0).toFixed(2),
          profit: roundMoney(Number(h.profit) || 0).toFixed(2), error: ''
        };
      })
    });
  },

  onHoldingAddInput(e) {
    const code = (e.detail.value || '').trim();
    if (!this.data.holdingsEdit) return;
    if (this._holdingAddTimer) clearTimeout(this._holdingAddTimer);
    this._holdingAddSeq = (this._holdingAddSeq || 0) + 1;
    this.setData({ holdingAddCode: e.detail.value || '', holdingAddError: '', holdingAddSearching: false, holdingsError: '' });
    if (!code) return;
    if (!/^\d{6}$/.test(code)) {
      if (code.length >= config.maxCodeLen) this.setData({ holdingAddError: '请输入 6 位基金代码' });
      return;
    }
    if (this.data.holdingsDraft.some(function (row) { return row.code === code; })) {
      this.setData({ holdingAddError: '该基金已在持有列表' });
      return;
    }
    this.setData({ holdingAddSearching: true });
    this._holdingAddTimer = setTimeout(() => this.lookupHoldingAdd(code), config.searchDebounce);
  },

  lookupHoldingAdd(code) {
    const seq = this._holdingAddSeq;
    return api.search(code).then((list) => {
      if (seq !== this._holdingAddSeq || !this.data.holdingsEdit || code !== this.data.holdingAddCode.trim()) return;
      const hit = (list || []).find(function (it) { return it.code === code && it.name; });
      if (!hit) {
        this.setData({ holdingAddSearching: false, holdingAddError: '未找到该基金' });
        return;
      }
      if (this.data.holdingsDraft.some(function (row) { return row.code === code; })) {
        this.setData({ holdingAddSearching: false, holdingAddError: '该基金已在持有列表' });
        return;
      }
      this.setData({
        holdingsDraft: this.data.holdingsDraft.concat({ code: code, name: hit.name, amount: '0.00', profit: '0.00', error: '' }),
        holdingAddCode: '', holdingAddSearching: false, holdingAddError: ''
      });
    }).catch(() => {
      if (seq !== this._holdingAddSeq || !this.data.holdingsEdit || code !== this.data.holdingAddCode.trim()) return;
      this.setData({ holdingAddSearching: false, holdingAddError: '查询失败，请重试' });
    });
  },

  onHoldingDraftInput(e) {
    const index = Number(e.currentTarget.dataset.index);
    const field = e.currentTarget.dataset.field;
    if (!this.data.holdingsEdit || !this.data.holdingsDraft[index] || (field !== 'amount' && field !== 'profit')) return;
    this.setData({
      ['holdingsDraft[' + index + '].' + field]: e.detail.value,
      ['holdingsDraft[' + index + '].error']: '',
      holdingsError: ''
    });
  },

  cancelHoldingsEdit() {
    if (this._holdingAddTimer) clearTimeout(this._holdingAddTimer);
    this._holdingAddSeq = (this._holdingAddSeq || 0) + 1;
    this.setData({
      holdingsEdit: false, holdingsDraft: [], holdingsError: '',
      holdingAddCode: '', holdingAddError: '', holdingAddSearching: false
    });
  },

  saveHoldingsEdit() {
    if (!this.data.holdingsEdit) return;
    const draft = this.data.holdingsDraft;
    const original = util.getHoldings();
    const byCode = new Map(original.map(function (h) { return [h.code, h]; }));
    if (draft.length < original.length ||
        original.some(function (h, i) { return draft[i].code !== h.code; })) {
      this.setData({ holdingsError: '持仓已变化，请取消后重新修改' });
      return;
    }
    const pendingCode = this.data.holdingAddCode.trim();
    if (pendingCode) {
      this.setData({
        holdingAddError: this.data.holdingAddSearching ? '正在查询基金，请稍后保存'
          : this.data.holdingAddError || '请等待基金名称识别后保存'
      });
      return;
    }
    let invalid = false;
    const next = new Map();
    const errors = {};
    draft.forEach((row, index) => {
      const amountText = String(row.amount).trim();
      const profitText = String(row.profit).trim();
      const amount = Number(amountText);
      const profit = Number(profitText);
      const error = !amountText || !Number.isFinite(amount) || amount < 0 ? '金额不能小于 0'
        : !profitText || !Number.isFinite(profit) ? '收益不合法' : '';
      errors['holdingsDraft[' + index + '].error'] = error;
      if (error) {
        invalid = true;
        return;
      }
      const roundedAmount = roundMoney(amount);
      const roundedProfit = roundMoney(profit);
      const old = byCode.get(row.code);
      const changed = old && (roundedAmount !== roundMoney(Number(old.amount)) || roundedProfit !== roundMoney(Number(old.profit)));
      // 改动的金额或收益重新建立结转基准，未改动的保留原 foldDate。
      next.set(row.code, old
        ? (!changed && old.amount === roundedAmount && old.profit === roundedProfit ? old
          : Object.assign({}, old, {
            amount: roundedAmount, profit: roundedProfit, foldDate: changed ? '' : old.foldDate
          }))
        : { code: row.code, name: row.name, amount: roundedAmount, profit: roundedProfit, foldDate: '' });
    });
    if (invalid) {
      this.setData(Object.assign(errors, { holdingsError: '请检查标红的金额或收益' }));
      return;
    }
    if (draft.length !== original.length || original.some(function (h) { return next.get(h.code) !== h; })) {
      util.setHoldings(draft.map(function (row) { return next.get(row.code); }));
    }
    this.cancelHoldingsEdit();
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
