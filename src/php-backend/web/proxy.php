<?php
// 本地没有的静态资源，回源官方 CDN（和 Node 私服行为一致）
// 访问方式：/proxy.php?p=src/settings.c1db0.js
$CDN = 'https://menggui-cdnres.bhsg.lintey.com/huawei/web-mobile';

$p = isset($_GET['p']) ? (string)$_GET['p'] : '';
$p = ltrim($p, '/');
if (strpos($p, 'client/') === 0) $p = substr($p, 7); // 客户端会带 /client 前缀
if ($p === '' || strpos($p, '..') !== false) {
    http_response_code(400);
    exit('bad path');
}

$url = $CDN . '/' . $p;

$mime = [
    'html' => 'text/html; charset=utf-8',
    'js'   => 'application/javascript; charset=utf-8',
    'json' => 'application/json; charset=utf-8',
    'css'  => 'text/css; charset=utf-8',
    'png'  => 'image/png',
    'jpg'  => 'image/jpeg',
    'jpeg' => 'image/jpeg',
    'webp' => 'image/webp',
    'gif'  => 'image/gif',
    'svg'  => 'image/svg+xml',
    'mp3'  => 'audio/mpeg',
    'ogg'  => 'audio/ogg',
    'wav'  => 'audio/wav',
    'ttf'  => 'font/ttf',
    'fnt'  => 'text/plain',
    'atlas' => 'text/plain',
    'txt'  => 'text/plain',
    'bin'  => 'application/octet-stream',
    'plist' => 'text/xml',
    'xml'  => 'text/xml',
];
$ext = strtolower(pathinfo($p, PATHINFO_EXTENSION));
$type = isset($mime[$ext]) ? $mime[$ext] : 'application/octet-stream';

$head = isset($_SERVER['REQUEST_METHOD']) && $_SERVER['REQUEST_METHOD'] === 'HEAD';

if (function_exists('curl_init')) {
    $ch = curl_init($url);
    curl_setopt($ch, CURLOPT_FOLLOWLOCATION, true);
    curl_setopt($ch, CURLOPT_CONNECTTIMEOUT, 10);
    curl_setopt($ch, CURLOPT_TIMEOUT, 120);
    curl_setopt($ch, CURLOPT_NOBODY, $head);
    curl_setopt($ch, CURLOPT_RETURNTRANSFER, true);
    curl_setopt($ch, CURLOPT_HEADER, false);
    curl_setopt($ch, CURLOPT_SSL_VERIFYPEER, false);
    curl_setopt($ch, CURLOPT_USERAGENT, 'ygjsz-private/1.0');
    $body = curl_exec($ch);
    $code = curl_getinfo($ch, CURLINFO_HTTP_CODE);
    $len = curl_getinfo($ch, CURLINFO_CONTENT_LENGTH_DOWNLOAD);
    $err = curl_error($ch);
    curl_close($ch);
    if ($body === false) {
        http_response_code(502);
        header('Content-Type: text/plain; charset=utf-8');
        exit('upstream fail: ' . $err);
    }
} else {
    $ctx = stream_context_create([
        'http' => ['method' => $head ? 'HEAD' : 'GET', 'timeout' => 60, 'follow_location' => 1, 'user_agent' => 'ygjsz-private/1.0'],
        'ssl'  => ['verify_peer' => false, 'verify_peer_name' => false],
    ]);
    $body = @file_get_contents($url, false, $ctx);
    $code = 0;
    $len = -1;
    if (isset($http_response_header)) {
        foreach ($http_response_header as $h) {
            if (preg_match('#^HTTP/\S+\s+(\d{3})#', $h, $m)) $code = (int)$m[1];
            if (stripos($h, 'Content-Length:') === 0) $len = (int)trim(substr($h, 15));
        }
    }
    if ($body === false) {
        http_response_code($code >= 400 ? $code : 502);
        header('Content-Type: text/plain; charset=utf-8');
        exit('upstream fail');
    }
}

if ($code >= 400) {
    http_response_code($code);
    header('Content-Type: text/plain; charset=utf-8');
    exit($code);
}

http_response_code(200);
header('Content-Type: ' . $type);
header('Access-Control-Allow-Origin: *');
header('Cache-Control: public, max-age=86400');
if ($len > 0) header('Content-Length: ' . $len);
if (!$head) echo $body;
