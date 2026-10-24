<?php
// 维护状态查询：游戏页 / WebSocket 服务用来判断要不要拦截访问
require __DIR__ . '/_common.php';
$m = yg_maint_get();
header('Cache-Control: no-store');
yg_json([
    'ok'    => 1,
    'on'    => empty($m['on']) ? 0 : 1,
    'msg'   => $m['msg'],
    'start' => (int)$m['start'],
    'end'   => (int)$m['end'],
    'now'   => time(),
]);
