const config = require('./utils/config.js');

App({
  globalData: {},

  onLaunch() {
    if (!wx.cloud) {
      wx.showToast({ title: '基础库过低，请升级到 2.2.3 以上', icon: 'none' });
      return;
    }
    wx.cloud.init({
      env: config.cloudEnv,
      traceUser: true
    });
  }
});
