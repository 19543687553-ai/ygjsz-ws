<?php
// 协议表/道具表，给 WS 服务端启动时拉取（跨域，所以走 PHP）
require __DIR__ . '/_common.php';

$f = isset($_GET['f']) ? preg_replace('/[^a-z0-9_]/i', '', $_GET['f']) : '';
$p = __DIR__ . '/data/' . $f . '.json';
if ($f === '' || !is_file($p)) {
    http_response_code(404);
    header('Content-Type: text/plain; charset=utf-8');
    echo '404';
    exit;
}
header('Content-Type: application/json; charset=utf-8');
header('Access-Control-Allow-Origin: *');
header('Cache-Control: public, max-age=300');
readfile($p);
