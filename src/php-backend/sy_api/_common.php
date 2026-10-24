<?php
// 公共函数：返回 JSON、取当前站点地址
function yg_cfg() {
    static $c = null;
    if ($c === null) $c = require __DIR__ . '/_config.php';
    return $c;
}

function yg_json($obj) {
    if (!headers_sent()) {
        header('Content-Type: application/json; charset=utf-8');
        header('Access-Control-Allow-Origin: *');
        header('Cache-Control: no-store');
    }
    echo json_encode($obj, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    exit;
}

// 当前站点的协议和域名（兼容反向代理）
function yg_base() {
    $proto = 'http';
    if (!empty($_SERVER['HTTP_X_FORWARDED_PROTO'])) {
        $proto = strtolower(trim(explode(',', $_SERVER['HTTP_X_FORWARDED_PROTO'])[0]));
    } elseif (!empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off') {
        $proto = 'https';
    }
    $host = !empty($_SERVER['HTTP_X_FORWARDED_HOST'])
        ? $_SERVER['HTTP_X_FORWARDED_HOST']
        : (isset($_SERVER['HTTP_HOST']) ? $_SERVER['HTTP_HOST'] : 'localhost');
    return [$proto, $host];
}

// ---------------- 维护模式 ----------------
// 状态放在 sy_api/state/maintenance.php，文件首行是 exit 语句，
// 直接访问只会得到空白，不会泄露内容。
function yg_maint_file() {
    return __DIR__ . '/state/maintenance.php';
}

function yg_maint_get() {
    $d = ['on' => 0, 'msg' => '服务器维护中，请稍后再试', 'start' => 0, 'end' => 0];
    $f = yg_maint_file();
    if (!is_file($f)) return $d;
    $s = file_get_contents($f);
    $p = strpos($s, "\n");
    if ($p === false) return $d;
    $j = json_decode(substr($s, $p + 1), true);
    if (is_array($j)) $d = array_merge($d, $j);
    return $d;
}

function yg_maint_set($on, $msg, $end = 0) {
    $dir = __DIR__ . '/state';
    if (!is_dir($dir)) @mkdir($dir, 0755, true);
    $f = yg_maint_file();
    $j = json_encode([
        'on'    => $on ? 1 : 0,
        'msg'   => (string)$msg,
        'start' => $on ? time() : 0,
        'end'   => (int)$end,
        'dt'    => date('Y-m-d H:i:s'),
    ], JSON_UNESCAPED_UNICODE);
    $tmp = $f . '.' . getmypid() . '.tmp';
    if (@file_put_contents($tmp, "<?php exit; ?>\n" . $j) === false) return false;
    if (!@rename($tmp, $f)) { @unlink($tmp); return false; }
    return true;
}

// 维护中时给接口用的统一拦截回包
function yg_maint_guard() {
    $m = yg_maint_get();
    if (empty($m['on'])) return;
    yg_json([
        'code'          => 0,
        'success'       => 1,
        'msg'           => $m['msg'] ? $m['msg'] : '服务器维护中，请稍后再试',
        'data'          => (object)[],
        'svrListT'      => [],
        'maintenance'   => 1,
    ]);
}
