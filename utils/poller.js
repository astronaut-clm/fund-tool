/**
 * 通用轮询器：封装 start/stop/间隔/交易时段判断/onUnload 自动清理
 * 用法：
 *   this._poller = createPoller({
 *     interval: 10000,
 *     onlyTrading: true,       // 仅交易时段才 tick
 *     onTick: () => this.load()
 *   });
 *   this._poller.start();
 *   onHide/onUnload → this._poller.stop();
 */
function createPoller(opts) {
  opts = opts || {};
  const interval = opts.interval || 10000;
  const onlyTrading = opts.onlyTrading !== false;
  const onTick = typeof opts.onTick === 'function' ? opts.onTick : function () {};
  const guard = typeof opts.guard === 'function' ? opts.guard : function () { return true; };

  let timer = null;
  let tick = 0;

  function stop() {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
    tick = 0;
  }

  function start() {
    stop();
    timer = setInterval(function () {
      if (onlyTrading) {
        const util = require('./util');
        if (!util.isTrading()) return;
      }
      if (!guard()) return;
      tick += 1;
      onTick(tick);
    }, interval);
  }

  return {
    start: start,
    stop: stop,
    get tick() { return tick; }
  };
}

module.exports = { createPoller: createPoller };
