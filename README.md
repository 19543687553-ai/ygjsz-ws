# 妖怪金手指 私服 · 开源继承包 v1.0

> 这是一个「交接包」：目标不是交付一个完美成品，而是让**下一个 AI / 下一个开发者**能在 30 分钟内看懂全局、继续干活，不用把前面踩过的坑再踩一遍。

## 一句话现状

**服务端骨架已经通了**：官方 H5 客户端能连上自建 PHP + Deno 服务，能登录、进主城、抽卡、匹配进 6 人战场、打完一关推图、GM 改数值生效、后台一键维护。
**还没通的**：战场内不刷怪、机器人队友不升级房门/床/不出战英雄、队友可能和你在同一房间、GM 面板缺物品 ID 且改完界面刷新慢。

## 技术栈（当前生产架构）

```
手机浏览器 / 壳 APK
   │  https
   ▼
zx.lytnb.top            ← 纯 PHP 虚拟主机（只能跑 PHP，不能跑常驻进程）
   ├─ /index.php        入口（维护时输出 503 维护页）
   ├─ /index.html       入口守卫（先问 maint.php，维护中就不跳转）
   ├─ /game.html        真正的游戏页（<base> 指向官方 CDN）
   ├─ /proxy.php        跨域代理（备用）
   └─ /sy_api/*.php     登录 / 版本信息 / 静态表 / 存档 / 日志 / 维护 / 后台
         │  https（只做 JSON 表 + 存档读写）
         ▼
Deno Deploy            ← 免费云，跑 WebSocket（游戏服 + 战斗服同一进程）
   └─ wss://<app>.deno.net/ws?role=battle&...
```

客户端所有静态资源（图集、配置 bin）**浏览器直连官方 CDN**，不经我们服务器（省流量、快）。
`remoteConfig/*.bin` 由 `sy_api/files.php` 提供（官方 CDN 上没有这两个文件）。

## 目录

```
README.md                       ← 你在这里
docs/00-给下一个AI的交接说明.md    ← 先读这个（身份、目标、约束、下一步）
docs/01-保姆级部署教程.md         ← 从零部署（手机也能操作）
docs/02-踩坑与修复全记录.md       ← 每个 bug 的根因和修法（最值钱）
docs/03-协议与数据结构.md         ← 封包格式、protobuf、关键 schema、GM 指令全表
docs/04-当前进度与已知问题.md     ← 能做什么 / 不能做什么 / 下一步怎么做
docs/05-抓包调试与日志.md         ← 抓包壳原理、日志上报、CDP 脚本、坐标换算
docs/06-仓库与SSH推送.md          ← 仓库地址、Deploy Key、推送命令
src/deno-ws/server.mjs          ← 线上主服务（Deno，~1700 行，单文件）
src/php-backend/                ← 线上 PHP 后端全部源码（含 remoteConfig/*.bin）
src/node-server/                ← 早期 Node 版私服（本地调试用，已被 PHP+Deno 取代）
data/capture/capture-main.json  ← 真实抓包原始数据（6MB，协议/回包的唯一真相来源）
tools/                          ← 端到端测试、协议编解码、抓包解析脚本
apk/                            ← 三个小体积壳 APK（Mod 版 / 抓包版 / 早期客户端）
screenshots/                    ← 关键节点截图（进主城、战场、抽卡结果、战斗结束）
```

> 可直接上传到 PHP 主机的「成品 zip」**不在本包内**（里面含真实 token/存档路径）。
> 需要时按 `docs/01` 的打包命令，从 `src/php-backend/` 自行生成即可（1 条命令）。

## 3 分钟自查（确认线上还是活的）

```bash
# 1. Deno 服务是否活着 + 是否在维护
curl https://ygjsz-ws.19543687553-ai.deno.net/health
#   → {"ok":true,"tables":...,"online":...,"maintenance":false,"msg":""}

# 2. PHP 后端是否有维护开关
curl https://zx.lytnb.top/sy_api/maint.php
#   → {"ok":1,"on":0,"msg":"...","start":0,"end":0,"now":...}

# 3. 后台地址（token 在 sy_api/_config.php）
#    https://zx.lytnb.top/sy_api/admin.php?token=CHANGE_ME_请替换成自己的token

# 4. 端到端：真连生产 WS，验证登录 / 6 人房 StartGameP / 结算
node tools/prod.mjs      # 需要 Node 22+（自带 WebSocket）
```

## 重要声明

- 本项目仅用于**单机/私服技术研究**：自建服务端、协议分析、客户端 hook。
- 不要把 token、Deploy Key、私钥提交到公开仓库（本包内已剔除真实密钥文件，token 是占位值）。
- `data/capture/capture-main.json` 是真实抓包，**含玩家 playerId 与官方会话票据（会过期）**，公开前建议自行脱敏。
- 游戏客户端、美术资源、配置表版权归原厂商所有，本包**不包含**任何官方二进制资源（`妖怪金手指_H5前端/` 971MB、官方 APK 900MB 均未打包）。

## 版本

- 继承包：v1.0（2026-10-24）
- 对应线上：PHP `v1.0.12` + Deno `server.mjs`（commit `f19b480` 之后）
