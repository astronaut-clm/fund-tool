/**
 * 分时图绘图逻辑：接收 canvas node + 走势数据 + 选中点，纯绘制
 * 页面只负责喂数据，绘图细节收敛到此处
 */

/**
 * 绘制分时走势图
 * @param {Object} canvas  canvas node
 * @param {Object} size    { width, height }
 * @param {Object} trend   { points:[{t,pct,nav}], prevNav }
 * @param {number} selIdx  选中的 points 下标，-1 表示无选中
 */
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

  // y 值域：估算净值，纳入上一净值基准
  let values = pts.map(function (p) { return p.nav; });
  values.push(trend.prevNav);
  let min = Math.min.apply(null, values);
  let max = Math.max.apply(null, values);
  const span = (max - min) || Math.abs(trend.prevNav) * 0.002;
  min -= span * 0.12;
  max += span * 0.12;

  // x 轴固定映射 09:30-15:00，午休（11:30-13:00）不体现，压缩掉该区间
  const toMin = function (s) { return Number(s.slice(0, 2)) * 60 + Number(s.slice(3)); };
  const T_START = toMin('09:30'); // 570
  const T_SPAN = 240; // 570→690(上午120) + 780→900(下午120)，中间午休90分钟压缩
  const compMin = function (m) { return m <= 690 ? m : m - 90; };
  const xAtT = function (t) { return padX + (chartW * (compMin(toMin(t)) - T_START)) / T_SPAN; };
  const yAt = function (v) { return padT + chartH * (1 - (v - min) / (max - min)); };

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

  // 面积渐变
  const grad = ctx.createLinearGradient(0, padT, 0, padT + chartH);
  grad.addColorStop(0, rising ? 'rgba(224,64,63,0.22)' : 'rgba(18,160,92,0.22)');
  grad.addColorStop(1, rising ? 'rgba(224,64,63,0.02)' : 'rgba(18,160,92,0.02)');
  ctx.beginPath();
  ctx.moveTo(xAtT(pts[0].t), yAt(pts[0].nav));
  pts.forEach(function (p) {
    ctx.lineTo(xAtT(p.t), yAt(p.nav));
  });
  ctx.lineTo(xAtT(pts[pts.length - 1].t), padT + chartH);
  ctx.lineTo(xAtT(pts[0].t), padT + chartH);
  ctx.closePath();
  ctx.fillStyle = grad;
  ctx.fill();

  // 折线
  ctx.beginPath();
  pts.forEach(function (p, i) {
    const x = xAtT(p.t);
    const y = yAt(p.nav);
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.lineWidth = 2;
  ctx.strokeStyle = mainColor;
  ctx.stroke();

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
  const ticks = ['09:30', '11:30/13:00', '15:00'];
  const tickT = ['09:30', '11:30', '15:00'];
  ticks.forEach(function (tk, i) {
    const x = xAtT(tickT[i]);
    ctx.textAlign = i === 0 ? 'left' : i === ticks.length - 1 ? 'right' : 'center';
    ctx.fillText(tk, x, padT + chartH + 4);
  });

  // 触摸游标
  if (selIdx >= 0 && selIdx < pts.length) {
    const x = xAtT(pts[selIdx].t);
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
