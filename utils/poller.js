/** 通用轮询器：start/stop/间隔/交易时段判断；onHide/onUnload 时 stop() */
function createPoller(opts) {
  opts = opts || {};
  const interval = opts.interval || 10000;
  const onlyTrading = opts.onlyTrading !== false;
  const onTick = typeof opts.onTick === 'function' ? opts.onTick : function () {};
  const guard = typeof opts.guard === 'function' ? opts.guard : function () { return true; };

  let timer = null;
  let stopped = true;

  function stop() {
    stopped = true;
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  }

  function scheduleNext() {
    if (!stopped) timer = setTimeout(runOnce, interval);
  }

  function runOnce() {
    if (stopped) return;
    const util = require('./util');
    if (onlyTrading && !util.isTrading()) return scheduleNext();
    if (!guard()) return scheduleNext();
    let ret;
    try {
      ret = onTick();
    } catch (e) {
      ret = Promise.reject(e);
    }
    // onTick 可返回 Promise：完成后再排下一次，避免堆积
    Promise.resolve(ret).then(scheduleNext, scheduleNext);
  }

  function start() {
    stop();
    stopped = false;
    scheduleNext();
  }

  return { start: start, stop: stop };
}

module.exports = { createPoller: createPoller };
