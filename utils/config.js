/**
 * 全局配置：云环境、轮询间隔等
 */
module.exports = {
  // 云开发环境 ID
  cloudEnv: 'cloud1-d8gg1i5ut09faeb83',
  // 列表/详情页轮询间隔（ms）
  pollInterval: 10000,
  // 搜索防抖（ms）
  searchDebounce: 350,
  // 基金代码最短查询长度
  minCodeLen: 5,
  // 基金代码最大长度
  maxCodeLen: 6,
  // 搜索历史最大条数
  maxHistory: 10
};
