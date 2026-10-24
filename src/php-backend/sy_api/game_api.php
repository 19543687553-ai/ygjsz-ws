<?php
// 登录接口：客户端带 action=login，返回服务器列表（s_ip 指向免费云上的 WS）
require __DIR__ . '/_common.php';
$cfg = yg_cfg();

// 维护模式：所有接口一律拒绝，客户端会停在登录/进入游戏前
yg_maint_guard();

$action = isset($_GET['action']) ? $_GET['action'] : '';

if ($action === 'login') {
    $uin = (string)$cfg['player_id'];
    yg_json([
        'success'        => 0,
        'msg'            => '',
        'sign'           => '',
        'time'           => (string)time(),
        't_token'        => 'dev_token',
        'access_token'   => 'dev_access',
        'prefix'         => '1_',
        'lastEnterGameDT' => '',
        'game_uin'       => '1_' . $uin,
        'sdk_uin'        => '1_' . $uin,
        'session_key'    => 'dev_session',
        'login_id_type'  => 0,
        'svrListT'       => [[
            's_ip'            => $cfg['ws_host'],
            'sPort'           => (string)$cfg['ws_port'],
            'port'            => (string)$cfg['ws_port'],
            'area'            => '1',
            's_id'            => '1',
            's_name'          => $cfg['server_name'],
            's_healthStatus'  => '3',
            'list_name'       => $cfg['server_name'],
            'pt_id'           => 4,
            'is_newUser'      => 2,
        ]],
    ]);
}

if ($action === 'get_AllServerList') {
    yg_json(['code' => 1, 'data' => []]);
}

if ($action === 'register') {
    yg_json(['code' => 1, 'success' => 0, 'game_uin' => (string)$cfg['player_id']]);
}

// 其它 action（pay_goods_list 等）先给个空壳，客户端不会崩
yg_json(['code' => 0, 'success' => 0, 'msg' => 'ok', 'data' => (object)[]]);
