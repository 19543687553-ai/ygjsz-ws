<?php
// 私服后台：一键开关维护模式
// 访问：/sy_api/admin.php?token=你的_token
require __DIR__ . '/_common.php';
$cfg = yg_cfg();

$token = isset($_POST['token']) ? (string)$_POST['token'] : (isset($_GET['token']) ? (string)$_GET['token'] : '');
$authed = $token !== '' && hash_equals((string)$cfg['token'], $token);

$notice = '';
if ($authed && $_SERVER['REQUEST_METHOD'] === 'POST') {
    $act = isset($_POST['act']) ? (string)$_POST['act'] : '';
    $msg = isset($_POST['msg']) ? trim((string)$_POST['msg']) : '';
    if ($msg === '') $msg = '服务器维护中，请稍后再试';
    $end = 0;
    if (!empty($_POST['end'])) {
        $t = strtotime((string)$_POST['end']);
        if ($t) $end = $t;
    }
    if ($act === 'on' || $act === 'off') {
        if (yg_maint_set($act === 'on', $msg, $act === 'on' ? $end : 0)) {
            $notice = $act === 'on'
                ? '已开启维护模式：玩家进不去，接口和 WebSocket 都会拦截'
                : '已关闭维护模式：玩家可以正常进入游戏';
        } else {
            $notice = '写入失败：请确认 sy_api/state/ 目录可写（权限 755 以上）';
        }
    }
}

$m = yg_maint_get();
$on = !empty($m['on']);
$stateDir = __DIR__ . '/state';
$writable = is_dir($stateDir) ? is_writable($stateDir) : is_writable(__DIR__);
$msgEsc = htmlspecialchars((string)$m['msg'], ENT_QUOTES, 'UTF-8');
$tokEsc = htmlspecialchars($token, ENT_QUOTES, 'UTF-8');
$endVal = !empty($m['end']) ? date('Y-m-d\TH:i', (int)$m['end']) : '';
if (!$authed) {
    header('Content-Type: text/html; charset=utf-8');
    header('Cache-Control: no-store');
    echo '<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">';
    echo '<title>后台登录</title><style>body{background:#0f1115;color:#e6e8ee;font-family:system-ui,sans-serif;display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0}';
    echo '.card{background:#181b22;padding:28px;border-radius:14px;max-width:420px;box-shadow:0 10px 40px #0006}';
    echo 'input{width:100%;box-sizing:border-box;padding:10px 12px;border-radius:8px;border:1px solid #2a2f3a;background:#0f1115;color:#e6e8ee;margin:8px 0 16px}';
    echo 'button{width:100%;padding:11px;border:0;border-radius:8px;background:#3b6cf6;color:#fff;font-size:15px;cursor:pointer}';
    echo 'p{color:#8b93a7;font-size:13px;line-height:1.6;margin:0 0 8px}</style></head><body>';
    echo '<form class="card" method="get"><h2 style="margin:0 0 6px">私服后台</h2>';
    echo '<p>请输入后台密钥（sy_api/_config.php 里的 token）</p>';
    echo '<input name="token" type="password" placeholder="token" autofocus><button type="submit">进入</button></form></body></html>';
    exit;
}
header('Content-Type: text/html; charset=utf-8');
header('Cache-Control: no-store');
?>
<!DOCTYPE html>
<html lang="zh-CN">

<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>私服后台 · 维护模式</title>
  <style>
    * { box-sizing: border-box; }
    body { margin: 0; background: #0f1115; color: #e6e8ee; font-family: system-ui, -apple-system, "PingFang SC", sans-serif; }
    .wrap { max-width: 720px; margin: 0 auto; padding: 24px 16px 60px; }
    h1 { font-size: 20px; margin: 6px 0 18px; }
    .card { background: #181b22; border: 1px solid #232833; border-radius: 14px; padding: 18px; margin-bottom: 16px; }
    .row { display: flex; justify-content: space-between; align-items: center; gap: 12px; flex-wrap: wrap; }
    .badge { padding: 5px 12px; border-radius: 999px; font-size: 13px; font-weight: 600; }
    .on { background: #3a1418; color: #ff7b7b; border: 1px solid #612029; }
    .off { background: #0f2418; color: #4ade80; border: 1px solid #1d5233; }
    .muted { color: #8b93a7; font-size: 13px; line-height: 1.7; }
    label { display: block; font-size: 13px; color: #9aa3b5; margin: 14px 0 6px; }
    input[type=text], input[type=datetime-local], textarea {
      width: 100%; padding: 10px 12px; border-radius: 8px; border: 1px solid #2a2f3a;
      background: #0f1115; color: #e6e8ee; font-size: 14px; font-family: inherit;
    }
    .btns { display: flex; gap: 10px; margin-top: 18px; flex-wrap: wrap; }
    button { padding: 11px 18px; border: 0; border-radius: 9px; font-size: 14px; cursor: pointer; font-weight: 600; }
    .start { background: #d9434a; color: #fff; }
    .stop { background: #2f9e57; color: #fff; }
    .notice { background: #16233a; border: 1px solid #27406b; color: #9ec1ff; padding: 10px 14px; border-radius: 9px; margin-bottom: 16px; font-size: 14px; }
    a { color: #6f9bff; }
    code { background: #0f1115; padding: 2px 6px; border-radius: 5px; font-size: 12px; }
  </style>
</head>

<body>
  <div class="wrap">
    <h1>私服后台 · 维护模式</h1>

    <?php if ($notice): ?>
      <div class="notice"><?php echo htmlspecialchars($notice, ENT_QUOTES, 'UTF-8'); ?></div>
    <?php endif; ?>

    <div class="card">
      <div class="row">
        <div>
          <div style="font-size:16px;font-weight:600">当前状态</div>
          <div class="muted"><?php echo $on ? ('开启于 ' . date('Y-m-d H:i', (int)$m['start'])) : '正常开放'; ?></div>
        </div>
        <span class="badge <?php echo $on ? 'on' : 'off'; ?>"><?php echo $on ? '维护中 · 已拦截访问' : '运行中'; ?></span>
      </div>
      <p class="muted" style="margin:14px 0 0">维护公告：<?php echo $msgEsc; ?></p>
      <?php if (!$writable): ?>
        <p class="muted" style="color:#ff8f8f;margin-top:10px">⚠ sy_api/state 目录不可写，开关会保存失败</p>
      <?php endif; ?>
    </div>

    <form class="card" method="post">
      <input type="hidden" name="token" value="<?php echo $tokEsc; ?>">
      <div style="font-size:16px;font-weight:600">一键维护</div>
      <p class="muted" style="margin:8px 0 0">
        开启后：游戏页直接返回维护页、登录接口拒绝登录、WebSocket 拒绝连接 —— 任何人都进不去、玩不了。
      </p>

      <label>维护公告（玩家看到的文字）</label>
      <input type="text" name="msg" maxlength="120" value="<?php echo $msgEsc; ?>" placeholder="服务器维护中，请稍后再试">

      <label>预计恢复时间（可选）</label>
      <input type="datetime-local" name="end" value="<?php echo htmlspecialchars($endVal, ENT_QUOTES, 'UTF-8'); ?>">

      <div class="btns">
        <button class="start" type="submit" name="act" value="on"
          onclick="return confirm('确定开启维护？所有玩家会立刻被踢出并无法进入')">开启维护</button>
        <button class="stop" type="submit" name="act" value="off">关闭维护</button>
      </div>
    </form>

    <div class="card">
      <div style="font-size:16px;font-weight:600;margin-bottom:10px">相关地址</div>
      <p class="muted">
        维护状态接口：<code>/sy_api/maint.php</code><br>
        游戏入口：<code>/</code>（维护时自动跳维护页）<br>
        WS 健康检查：<code>https://<?php echo htmlspecialchars($cfg['ws_host'], ENT_QUOTES, 'UTF-8'); ?>/health</code>
      </p>
    </div>
  </div>
</body>

</html>
