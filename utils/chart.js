/** 分时图绘制：接收 canvas node + 走势数据 + 选中点，纯绘制 */
function drawTrend(canvas, size, trend, selIdx) {
  if (!canvas || !size || !trend || !trend.points || trend.points.length < 2) return;
  const ctx = canvas.getContext('2d');
  const dpr = (wx.getWindowInfo && wx.getWindowInfo().pixelRatio) || 2;
  const W = size.width;
  const H = size.height;
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

  // y 值域：估算净值 + 上一净值基准
  let values = pts.map(function (p) { return p.nav; });
  values.push(trend.prevNav);
  let min = Math.min.apply(null, values);
  let max = Math.max.apply(null, values);
  const span = (max - min) || Math.abs(trend.prevNav) * 0.002;
  min -= span * 0.12;
  max += span * 0.12;

  const yAt = function (v) { return padT + chartH * (1 - (v - min) / (max - min)); };

  // 固定时间轴：09:30-11:30/13:00-15:00（下午），午休段空白
  const SESS = [
    { s: '09:30', e: '11:30', len: 120 },
    { s: '13:00', e: '15:00', len: 120 }
  ];
  const TOTAL_MIN = 240;

  function tToMin(t) {
    if (!t) return -1;
    const m = String(t).match(/^(\d{1,2}):(\d{2})/);
    if (!m) return -1;
    return Number(m[1]) * 60 + Number(m[2]);
  }
  // 时间 → x 偏移（0..TOTAL_MIN），午休段返回 -1 表示空白
  function tToOffset(t) {
    const min = tToMin(t);
    if (min < 0) return -1;
    // 09:30-11:30
    const m0 = tToMin(SESS[0].s);
    const m1 = tToMin(SESS[0].e);
    const m2 = tToMin(SESS[1].s);
    const m3 = tToMin(SESS[1].e);
    if (min >= m0 && min <= m1) return min - m0;
    if (min >= m2 && min <= m3) return SESS[0].len + (min - m2);
    return -1;
  }
  function offsetToX(off) {
    return padX + (chartW * off) / (TOTAL_MIN - 1);
  }
  function tToX(t) {
    const off = tToOffset(t);
    if (off < 0) return null;
    return offsetToX(off);
  }

  const lastPct = pts[pts.length - 1].pct;
  const rising = lastPct >= 0;
  const mainColor = rising ? '#e0403f' : '#12a05c';

  // 网格
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

  const xs = pts.map(function (p) { return tToX(p.t); });

  // 面积渐变（分段绘制，午休段不连接）
  const grad = ctx.createLinearGradient(0, padT, 0, padT + chartH);
  grad.addColorStop(0, rising ? 'rgba(224,64,63,0.22)' : 'rgba(18,160,92,0.22)');
  grad.addColorStop(1, rising ? 'rgba(224,64,63,0.02)' : 'rgba(18,160,92,0.02)');

  let segStart = -1;
  function flushAreaSeg(end) {
    if (segStart < 0 || end <= segStart) { segStart = -1; return; }
    ctx.beginPath();
    ctx.moveTo(xs[segStart], yAt(pts[segStart].nav));
    for (let i = segStart + 1; i <= end; i++) {
      ctx.lineTo(xs[i], yAt(pts[i].nav));
    }
    ctx.lineTo(xs[end], padT + chartH);
    ctx.lineTo(xs[segStart], padT + chartH);
    ctx.closePath();
    ctx.fillStyle = grad;
    ctx.fill();
    segStart = -1;
  }
  function flushLineSeg(end) {
    if (segStart < 0 || end <= segStart) { segStart = -1; return; }
    ctx.beginPath();
    for (let i = segStart; i <= end; i++) {
      if (i === segStart) ctx.moveTo(xs[i], yAt(pts[i].nav));
      else ctx.lineTo(xs[i], yAt(pts[i].nav));
    }
    ctx.lineWidth = 2;
    ctx.strokeStyle = mainColor;
    ctx.stroke();
    segStart = -1;
  }

  // 先面积
  for (let i = 0; i < pts.length; i++) {
    if (xs[i] === null) {
      flushAreaSeg(i - 1);
    } else if (segStart < 0) {
      segStart = i;
    }
  }
  flushAreaSeg(pts.length - 1);

  // 再折线
  segStart = -1;
  for (let i = 0; i < pts.length; i++) {
    if (xs[i] === null) {
      flushLineSeg(i - 1);
    } else if (segStart < 0) {
      segStart = i;
    }
  }
  flushLineSeg(pts.length - 1);

  // 左侧刻度
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

  // 底部时间轴
  ctx.textBaseline = 'top';
  ctx.fillStyle = '#8a9099';
  ctx.textAlign = 'left';
  ctx.fillText('09:30', offsetToX(0), padT + chartH + 4);
  ctx.textAlign = 'center';
  ctx.fillText('11:30/13:00', offsetToX(120), padT + chartH + 4);
  ctx.textAlign = 'right';
  ctx.fillText('15:00', offsetToX(TOTAL_MIN - 1), padT + chartH + 4);

  // 触摸游标
  if (selIdx >= 0 && selIdx < pts.length && xs[selIdx] !== null) {
    const x = xs[selIdx];
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
}

module.exports = { drawTrend: drawTrend };
