<?php
// 游戏入口：维护模式时直接返回维护页，否则输出 index.html
// （在 .htaccess 里把 / 和 /index.html 都指向这里）
require __DIR__ . '/sy_api/_common.php';

header('Cache-Control: no-store');

$m = yg_maint_get();
if (!empty($m['on'])) {
    $msg = htmlspecialchars(trim((string)$m['msg']) !== '' ? $m['msg'] : '服务器维护中，请稍后再试', ENT_QUOTES, 'UTF-8');
    $end = (int)$m['end'];
    $endText = $end > 0 ? htmlspecialchars(date('Y-m-d H:i', $end), ENT_QUOTES, 'UTF-8') : '';
    header('Content-Type: text/html; charset=utf-8');
    header('HTTP/1.1 503 Service Unavailable');
    ?>
    <!DOCTYPE html>
    <html lang="zh-CN">

    <head>
      <meta charset="utf-8">
      <meta name="viewport" content="width=device-width,initial-scale=1,user-scalable=no">
      <title>服务器维护中</title>
      <style>
        * { box-sizing: border-box; }
        html, body { height: 100%; }
        body {
          margin: 0; background: radial-gradient(1200px 600px at 50% -10%, #1d2740 0%, #0d1016 60%, #08090c 100%);
          color: #e6e8ee; font-family: system-ui, -apple-system, "PingFang SC", sans-serif;
          display: flex; align-items: center; justify-content: center; padding: 24px;
        }
        .box { width: 100%; max-width: 460px; text-align: center; }
        .icon {
          width: 74px; height: 74px; margin: 0 auto 22px; border-radius: 22px;
          background: linear-gradient(145deg, #2b3a5c, #161d2c);
          border: 1px solid #35466d;
          display: flex; align-items: center; justify-content: center; font-size: 34px;
        }
        h1 { font-size: 22px; margin: 0 0 12px; letter-spacing: .5px; }
        p { margin: 0 0 8px; color: #9aa3b5; font-size: 15px; line-height: 1.75; }
        .end { color: #6f9bff; font-size: 14px; }
        .hint { margin-top: 26px; font-size: 12px; color: #5c6478; }
        .dot { display: inline-block; width: 7px; height: 7px; border-radius: 50%; background: #4ade80; margin-right: 6px; animation: b 1.4s infinite; }
        @keyframes b { 0%, 100% { opacity: .25 } 50% { opacity: 1 } }
      </style>
    </head>

    <body>
      <div class="box">
        <div class="icon">🛠</div>
        <h1>服务器维护中</h1>
        <p><?php echo $msg; ?></p>
        <?php if ($endText !== ''): ?>
          <p class="end">预计恢复时间：<?php echo $endText; ?></p>
        <?php endif; ?>
        <p class="hint"><span class="dot"></span>本页 30 秒后自动刷新，维护结束后自动进入游戏</p>
      </div>
      <script>
        setTimeout(function () { location.replace(location.pathname + '?t=' + Date.now()); }, 30000);
      </script>
    </body>

    </html>
    <?php
    exit;
}

header('Content-Type: text/html; charset=utf-8');
readfile(__DIR__ . '/game.html');
