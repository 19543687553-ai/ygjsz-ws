<?php
// 给免费云上的 WS 服务读写存档用，带密钥，别公开
require __DIR__ . '/_common.php';
$cfg = yg_cfg();

$token = isset($_GET['token']) ? $_GET['token'] : '';
if ($token !== $cfg['token']) {
    http_response_code(403);
    yg_json(['ok' => 0, 'msg' => 'bad token']);
}

$dir = __DIR__ . '/state';
if (!is_dir($dir)) @mkdir($dir, 0755, true);
$file = $dir . '/player.php';

if ($_SERVER['REQUEST_METHOD'] === 'POST') {
    $raw = file_get_contents('php://input');
    if ($raw === false || $raw === '') {
        yg_json(['ok' => 0, 'msg' => 'empty body']);
    }
    // 先写临时文件再改名，避免写一半被读到
    $tmp = $file . '.' . getmypid() . '.tmp';
    $ok = @file_put_contents($tmp, "<?php exit; ?>\n" . $raw);
    if ($ok === false || !@rename($tmp, $file)) {
        @unlink($tmp);
        yg_json(['ok' => 0, 'msg' => 'write failed']);
    }
    yg_json(['ok' => 1, 'size' => $ok]);
}

// GET：读存档，没有就返回 null，由 WS 端建默认档
$data = null;
if (is_file($file)) {
    $s = file_get_contents($file);
    $p = strpos($s, "\n");
    if ($p !== false) $data = substr($s, $p + 1);
}
yg_json(['ok' => 1, 'data' => $data]);
