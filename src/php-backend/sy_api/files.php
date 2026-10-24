<?php
// 私有资源输出：官方 CDN 上没有 remoteConfig / config_all 的 bin，
// 这里带 CORS 头输出，供游戏跨域加载
$allow = [
    'preload_config.hunfu147127.bin' => 'preload_config.hunfu147127.bin',
    'config.hunfu147127.bin'         => 'config.hunfu147127.bin',
];

header('Access-Control-Allow-Origin: *');
header('Access-Control-Allow-Headers: *');
header('Cache-Control: public, max-age=86400');

$f = isset($_GET['f']) ? basename((string)$_GET['f']) : '';
if (!isset($allow[$f])) {
    http_response_code(404);
    header('Content-Type: text/plain; charset=utf-8');
    echo 'not found';
    exit;
}

$p = __DIR__ . '/../remoteConfig/' . $allow[$f];
if (!is_file($p)) {
    http_response_code(404);
    exit;
}

header('Content-Type: application/octet-stream');
header('Content-Length: ' . filesize($p));
readfile($p);
