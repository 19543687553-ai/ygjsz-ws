<?php
// 私服配置：改这个文件就行
return [
    // 免费云上 WebSocket 服务的地址，不要带 wss://，只写域名
    // 例：'ygjsz-abc.deno.dev'
    'ws_host' => 'ygjsz-ws.19543687553-ai.deno.net',
    // WebSocket 端口，https 就是 443
    'ws_port' => '443',
    // 内部接口密钥：和 WS 服务端保持一致，随便改一串别人猜不到的
    'token'   => 'CHANGE_ME_请替换成自己的token',

    // 静态资源根：留空=自动用 ws_host + /res（WS 服务会代理 CDN 和 remoteConfig）
    // 只有把域名换掉时才需要改
    'res_host' => '',
    // 官方资源 CDN（页面 <base> 指向这里，浏览器直连，比云函数代理快）
    'cdn_host' => 'menggui-cdnres.bhsg.lintey.com/huawei/web-mobile',

    // 下面这些不用动
    'version'    => 'online',
    'js_ver'     => '147192',
    'config_ver' => 'hunfu147127',
    'player_id'  => 67820771,
    'server_name' => '678服',
];
