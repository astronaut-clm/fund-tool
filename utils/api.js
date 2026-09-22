/** 云函数调用封装（第三方接口需域名白名单，统一走云函数代理） */
const FUNCTION_NAME = 'fundApi';

function call(action, data) {
  return wx.cloud
    .callFunction({
      name: FUNCTION_NAME,
      data: Object.assign({ action: action }, data || {})
    })
    .then(function (res) {
      const result = res && res.result;
      if (!result) throw new Error('云函数返回为空');
      if (result.ok === false) throw new Error(result.msg || '请求失败');
      return result.data;
    })
    .catch(function (err) {
      const msg = (err && err.errMsg) || (err && err.message) || '';
      if (msg.indexOf('FunctionName') >= 0 || msg.indexOf('not found') >= 0) {
        throw new Error('云函数未部署：请在开发者工具右键 cloudfunctions/fundApi → 上传并部署');
      }
      throw new Error(msg || '网络异常');
    });
}

/** 基金搜索联想 */
function search(key) {
  return call('search', { key: key });
}

/** 估值（withStocks=true 返回前十大持仓明细，详情页用） */
function estimate(codes, withStocks) {
  return call('estimate', { codes: codes, withStocks: !!withStocks });
}

/** 当日估算分时（分钟级） */
function trend(code) {
  return call('trend', { code: code });
}

module.exports = { search: search, estimate: estimate, trend: trend };
