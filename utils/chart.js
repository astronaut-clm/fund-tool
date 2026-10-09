/** 分时图绘制 + 触摸命中 */
const PAD_T = 18;
const PAD_B = 16;
const PAD_X = 46;
const PAD_R = 8;

// 固定时间轴 09:30-11:30 / 13:00-15:00，午休段空白
const TOTAL_MIN = 240;
const M_AM_S = 9 * 60 + 30;
const M_AM_E = 11 * 60 + 30;
const M_PM_S = 13 * 60;
const M_PM_E = 15 * 60;

function tToMin(t) {
  const m = String(t || '').match(/^(\d{1,2}):(\d{2})/);
  return m ? Number(m[1]) * 60 + Number(m[2]) : -1;
}

/** 时间 → x 偏移（0..TOTAL_MIN），非交易时段返回 -1 */
function tToOffset(t) {
  const min = tToMin(t);
  if (min < 0) return -1;
  if (min >= M_AM_S && min <= M_AM_E) return min - M_AM_S;
  if (min >= M_PM_S && min <= M_PM_E) return M_AM_E - M_AM_S + (min - M_PM_S);
  return -1;
}

/** 触摸 x（画布内 CSS 像素）→ 最近数据点索引，未命中返回 -1 */
function hitTest(trend, x, width) {
  const pts = trend && trend.points;
  if (!pts || pts.length < 2) return -1;
  const chartW = width - PAD_X - PAD_R;
  if (chartW <= 0) return -1;
  const off = Math.min(1, Math.max(0, (x - PAD_X) / chartW)) * (TOTAL_MIN - 1);
  let bestIdx = -1;
  let bestDist = Infinity;
  for (let i = 0; i < pts.length; i++) {
    const o = tToOffset(pts[i].t);
    if (o < 0) continue;
    const d = Math.abs(o - off);
    if (d < bestDist) {
      bestDist = d;
      bestIdx = i;
    }
  }
  return bestIdx;
}

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
  const chartW = W - PAD_X - PAD_R;
  const chartH = H - PAD_T - PAD_B;

  // y 值域：估算净值 + 上一净值基准
  const values = pts.map(function (p) { return p.nav; });
  values.push(trend.prevNav);
  let min = Math.min.apply(null, values);
  let max = Math.max.apply(null, values);
  const span = (max - min) || Math.abs(trend.prevNav) * 0.002;
  min -= span * 0.12;
  max += span * 0.12;

  const yAt = function (v) { return PAD_T + chartH * (1 - (v - min) / (max - min)); };
  const offsetToX = function (off) { return PAD_X + (chartW * off) / (TOTAL_MIN - 1); };
  const tToX = function (t) {
    const off = tToOffset(t);
    return off < 0 ? null : offsetToX(off);
  };

  const rising = pts[pts.length - 1].pct >= 0;
  const mainColor = rising ? '#e0403f' : '#12a05c';

  ctx.lineWidth = 1;
  // 网格
  ctx.strokeStyle = '#f0f1f3';
  ctx.beginPath();
  for (let g = 0; g <= 4; g++) {
    const y = PAD_T + (chartH * g) / 4;
    ctx.moveTo(PAD_X, y);
    ctx.lineTo(PAD_X + chartW, y);
  }
  ctx.stroke();

  // 上一净值基准线
  const yBase = yAt(trend.prevNav);
  ctx.setLineDash([4, 4]);
  ctx.strokeStyle = '#c9ced4';
  ctx.beginPath();
  ctx.moveTo(PAD_X, yBase);
  ctx.lineTo(PAD_X + chartW, yBase);
  ctx.stroke();
  ctx.setLineDash([]);

  const xs = pts.map(function (p) { return tToX(p.t); });

  // 面积渐变
  const grad = ctx.createLinearGradient(0, PAD_T, 0, PAD_T + chartH);
  grad.addColorStop(0, rising ? 'rgba(224,64,63,0.22)' : 'rgba(18,160,92,0.22)');
  grad.addColorStop(1, rising ? 'rgba(224,64,63,0.02)' : 'rgba(18,160,92,0.02)');

  // 分段绘制（午休段不连接）：先面积后折线
  let segStart = -1;
  function flushAreaSeg(end) {
    if (segStart < 0 || end <= segStart) {
      segStart = -1;
      return;
    }
    ctx.beginPath();
    ctx.moveTo(xs[segStart], yAt(pts[segStart].nav));
    for (let i = segStart + 1; i <= end; i++) ctx.lineTo(xs[i], yAt(pts[i].nav));
    ctx.lineTo(xs[end], PAD_T + chartH);
    ctx.lineTo(xs[segStart], PAD_T + chartH);
    ctx.closePath();
    ctx.fillStyle = grad;
    ctx.fill();
    segStart = -1;
  }
  function flushLineSeg(end) {
    if (segStart < 0 || end <= segStart) {
      segStart = -1;
      return;
    }
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
  function drawSegments(flush) {
    for (let i = 0; i < pts.length; i++) {
      if (xs[i] === null) flush(i - 1);
      else if (segStart < 0) segStart = i;
    }
    flush(pts.length - 1);
    segStart = -1;
  }
  drawSegments(flushAreaSeg);
  drawSegments(flushLineSeg);

  // 左侧刻度
  ctx.font = '10px -apple-system, sans-serif';
  ctx.fillStyle = '#8a9099';
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  for (let g = 0; g <= 4; g++) {
    const v = max - ((max - min) * g) / 4;
    ctx.fillText(((v / trend.prevNav - 1) * 100).toFixed(2) + '%', PAD_X - 6, PAD_T + (chartH * g) / 4);
  }
  ctx.fillStyle = '#6b7280';
  ctx.fillText('0.00%', PAD_X - 6, yBase);

  // 底部时间轴
  ctx.textBaseline = 'top';
  ctx.fillStyle = '#8a9099';
  ctx.textAlign = 'left';
  ctx.fillText('09:30', offsetToX(0), PAD_T + chartH + 4);
  ctx.textAlign = 'center';
  ctx.fillText('11:30/13:00', offsetToX(M_AM_E - M_AM_S), PAD_T + chartH + 4);
  ctx.textAlign = 'right';
  ctx.fillText('15:00', offsetToX(TOTAL_MIN - 1), PAD_T + chartH + 4);

  // 触摸游标
  if (selIdx >= 0 && selIdx < pts.length && xs[selIdx] !== null) {
    const x = xs[selIdx];
    const y = yAt(pts[selIdx].nav);
    ctx.strokeStyle = '#9aa3ad';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x, PAD_T);
    ctx.lineTo(x, PAD_T + chartH);
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

module.exports = { drawTrend: drawTrend, hitTest: hitTest };
