<?php
// 版本信息：客户端启动第一个请求，返回接口地址和配置
require __DIR__ . '/_common.php';
$cfg = yg_cfg();
list($proto, $host) = yg_base();

$checkConfig = [
    'LogOpen:0',
    'DebugOpen:0',
    'isAdvertise:0',
    'EnableConsoleLog:1',
    'OpenGM:1',
    // 关掉新手引导：客户端 LoginView 会 getPerformConfig(CloseGuide) -> switchGuideEnable(!v)。
    // 开着引导时，打完第一关会打开 GuideView，而它内部 roleSpineHandler 没初始化好，
    // 会抛 "Cannot read properties of undefined (reading 'play')"，引导又指不到目标（宽高 0），
    // 弹窗把全屏点击吃掉 -> 看起来“什么也玩不了”。
    'CloseGuide:1',
    'GuideAutoReady:1',
    'Team2Speed:1',
    'BattleUpload:0',
    'BattleSilenceUpload:0',
    'MiniGame:0',
    'UserAndPrivacy:huawei',
    'publishInfo0:私服测试',
];

yg_json([
    'code' => 1,
    'data' => [
        'version'            => $cfg['version'],
        'http_server'        => $proto . '://' . $host . '/sy_api/game_api.php',
        'http_server_shenhe' => $proto . '://' . $host . '/sy_api/game_api.php',
        'res_host'           => (!empty($cfg['res_host']) ? $cfg['res_host'] : (!empty($cfg['cdn_host']) ? $cfg['cdn_host'] : $cfg['ws_host'] . '/res')),
        'checkConfig'        => json_encode($checkConfig),
        'JSVer'              => $cfg['js_ver'],
        'cver'               => $cfg['js_ver'],
        'configVer'          => $cfg['config_ver'],
        't'                  => time(),
    ],
]);
