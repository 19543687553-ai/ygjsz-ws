<?php
// 客户端日志上报 / 查看
// 上报：POST JSON {"t":时间,"url":页面,"logs":[{lv,m}]}
// 查看（都要 token）：
//   ?token=xxx                     纯文本，默认最后 300 条
//   &tail=500&q=error&day=20261024  过滤
//   &mode=json                     结构化 JSON（给脚本/助手读）
//   &mode=miss                     聚合所有“无回包”的 module/cmd，按次数排序
//   &mode=summary                  概览：条数/报错数/时间范围/高频错误
date_default_timezone_set('Asia/Shanghai');
$cfg = require __DIR__ . '/_config.php';
$dir = __DIR__ . '/logs';
if (!is_dir($dir)) @mkdir($dir, 0777, true);

// 清掉 7 天前的日志
foreach (glob($dir . '/*.jsonl') ?: [] as $old) {
    if (filemtime($old) < time() - 7 * 86400) @unlink($old);
}

if ($_SERVER['REQUEST_METHOD'] === 'POST') {
    $raw = file_get_contents('php://input');
    if ($raw === false || strlen($raw) > 300000) {
        http_response_code(413);
        exit('too large');
    }
    $j = json_decode($raw, true);
    if (!is_array($j)) {
        http_response_code(400);
        exit('bad json');
    }
    $f = $dir . '/' . date('Ymd') . '.jsonl';
    @file_put_contents(
        $f,
        json_encode($j, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES) . "\n",
        FILE_APPEND | LOCK_EX
    );
    header('Content-Type: application/json');
    header('Access-Control-Allow-Origin: *');
    echo '{"ok":true}';
    exit;
}

if (($_GET['token'] ?? '') !== $cfg['token']) {
    http_response_code(403);
    header('Content-Type: text/plain; charset=utf-8');
    exit('forbidden: 需要 ?token=');
}

$day  = preg_replace('/\D/', '', $_GET['day'] ?? '') ?: date('Ymd');
$file = $dir . '/' . $day . '.jsonl';
$mode = $_GET['mode'] ?? 'text';

if (!is_file($file)) {
    if ($mode === 'json') {
        header('Content-Type: application/json');
        echo json_encode(['day' => $day, 'rows' => [], 'msg' => 'no log']);
    } else {
        header('Content-Type: text/plain; charset=utf-8');
        echo '今天还没有日志：' . $day;
    }
    exit;
}

// 拉平成一条条日志
$rows = [];
foreach (file($file, FILE_IGNORE_NEW_LINES | FILE_SKIP_EMPTY_LINES) ?: [] as $line) {
    $j = json_decode($line, true);
    if (!is_array($j)) continue;
    foreach (($j['logs'] ?? []) as $r) {
        $rows[] = [
            't'   => (int)($j['t'] ?? 0),
            'lv'  => (string)($r['lv'] ?? 'log'),
            'm'   => (string)($r['m'] ?? ''),
            'url' => (string)($j['url'] ?? ''),
        ];
    }
}

if ($mode === 'json' || $mode === 'miss' || $mode === 'summary') {
    header('Content-Type: application/json; charset=utf-8');
    header('Access-Control-Allow-Origin: *');
}

if ($mode === 'miss') {
    $miss = [];
    foreach ($rows as $r) {
        if (preg_match('/\[无回包\]\s*module\/cmd\s*(.+)$/u', $r['m'], $mt)) {
            foreach (preg_split('/\s*,\s*/', trim($mt[1])) as $one) {
                if ($one === '') continue;
                $miss[$one] = ($miss[$one] ?? 0) + 1;
            }
        }
    }
    arsort($miss);
    echo json_encode(['day' => $day, 'total' => count($rows), 'miss' => $miss], JSON_UNESCAPED_UNICODE);
    exit;
}

if ($mode === 'summary') {
    $errs = [];
    $first = null;
    $last = null;
    $errCount = 0;
    foreach ($rows as $r) {
        $ts = (int)($r['t'] / 1000);
        if ($ts && ($first === null || $ts < $first)) $first = $ts;
        if ($ts && ($last === null || $ts > $last)) $last = $ts;
        if ($r['lv'] === 'error' || stripos($r['m'], 'Script error') !== false) {
            $errCount++;
            $k = mb_substr($r['m'], 0, 120);
            $errs[$k] = ($errs[$k] ?? 0) + 1;
        }
    }
    arsort($errs);
    echo json_encode([
        'day' => $day,
        'total' => count($rows),
        'errors' => $errCount,
        'from' => $first ? date('H:i:s', $first) : null,
        'to'   => $last ? date('H:i:s', $last) : null,
        'topErrors' => array_slice($errs, 0, 10, true),
    ], JSON_UNESCAPED_UNICODE);
    exit;
}

if ($mode === 'json') {
    echo json_encode(['day' => $day, 'total' => count($rows), 'rows' => $rows], JSON_UNESCAPED_UNICODE);
    exit;
}

// 文本模式
header('Content-Type: text/plain; charset=utf-8');
$tail = max(1, (int)($_GET['tail'] ?? 300));
$q = trim((string)($_GET['q'] ?? ''));
if ($q !== '') {
    $rows = array_values(array_filter($rows, fn($r) => stripos($r['m'], $q) !== false));
}
$out = array_slice($rows, -$tail);
echo '共 ' . count($rows) . " 条，显示最后 " . count($out) . " 条\n\n";
foreach ($out as $r) {
    echo date('H:i:s', (int)($r['t'] / 1000)) . ' [' . $r['lv'] . '] ' . $r['m'] . "\n";
}
