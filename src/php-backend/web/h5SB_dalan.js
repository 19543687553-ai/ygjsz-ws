// 私服专用 SDK 桩：替代官方 h5SB_dalan.js，跳过华为/大蓝 SDK 登录
// 客户端只依赖 window._h5_platform 的这些方法
(function () {
  var DEV_UID = 'dev_' + Date.now();
  var DEV_TOKEN = 'dev_token';
  var DEV_EXT = {
    channel_id: '282',
    game_channel_id: '7158',
    game_id: '191',
    game_name: '妖怪金手指',
    game_ver: '1.0.0.0',
  };

  window._h5_platform = {
    init: function () {
      console.log('[devsdk] init');
    },
    login: function (cb) {
      console.log('[devsdk] login');
      setTimeout(function () {
        cb({ err: 0, uid: DEV_UID, token: DEV_TOKEN, ext: DEV_EXT });
      }, 0);
    },
    switchAccount: function () {},
    purchase: function () {},
    gameReport: function (data, cb) {
      if (cb) cb();
    },
    share: function (data, cb) {
      if (cb) cb();
    },
    getOsCode: function () {
      return 2;
    },
    cmd: function (data, cb) {
      if (cb) cb({});
    },
    restart: function () {
      location.reload();
    },
    exitGame: function () {
      location.reload();
    },
    loadAds: function (data, cb) {
      if (cb) cb();
    },
    showAds: function (data, cb) {
      if (cb) cb(3); // ADS_STATUS.SUCCESS
    },
    canIUse: function () {
      return true;
    },
    getAdsIcon: function () {
      return 'resources/ui/common/common_frame/common_img_luxiang';
    },
    nodeRecord: function () {},
    openKefu: function () {},
  };
})();
