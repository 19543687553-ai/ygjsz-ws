# 06 · 仓库与 SSH 推送

---

## 1. 仓库

| 项 | 值 |
|---|---|
| 仓库 | `git@github.com:19543687553-ai/ygjsz-ws.git` |
| 默认分支 | `main` |
| 内容 | `server.mjs`（Deno 入口，必须在根目录）+ 本继承包的全部文档/源码/工具 |
| 绑定 | Deno Deploy 监听本仓库，**push 即自动重新部署** |

> ⚠️ `server.mjs` 必须留在仓库**根目录**且文件名不变，否则 Deno 的 Entrypoint 配置会失效。

---

## 2. SSH 推送（手机/受限网络环境）

### 2.1 一次性准备：加 Deploy Key

如果沙箱/新机器上没有可用私钥，生成一把新的：

```bash
ssh-keygen -t ed25519 -C "ygjsz-deploy" -f ~/.ssh/ygjsz_deploy -N ""
cat ~/.ssh/ygjsz_deploy.pub
```

打开 `https://github.com/19543687553-ai/ygjsz-ws/settings/keys` →
**Add deploy key** → 粘贴公钥 → **勾选 Allow write access** → Add key。

> Deploy Key 是**只对这个仓库**有写权限的密钥，比个人 SSH Key 安全。
> 本继承包里**没有**任何私钥（已剔除），必须自己生成 + 让仓库所有者加。

### 2.2 走代理 + 443 端口推送

很多网络环境屏蔽 22 端口 / 直连 GitHub 超时。用 SSH over 443（`ssh.github.com`）+ 本地 HTTP 代理：

```bash
GIT_SSH_COMMAND="ssh -o StrictHostKeyChecking=no -o ConnectTimeout=12 \
  -o ProxyCommand='nc -X connect -x 127.0.0.1:18080 %h %p' -p 443" \
  git push origin main
```

- `-p 443` 表示连 `ssh.github.com:443`（需要把 remote 写成 `git@ssh.github.com:owner/repo.git`，或配 `~/.ssh/config`）。
- `ProxyCommand ... -x 127.0.0.1:18080` 是沙箱内的 HTTP 代理端口，**不同环境端口不同**，看环境变量 `HTTP_PROXY`。
- 没有代理直连时，去掉 `-o ProxyCommand=...` 即可。

### 2.3 推荐 `~/.ssh/config`（省得每次敲）

```
Host github.com
  HostName ssh.github.com
  Port 443
  User git
  IdentityFile ~/.ssh/ygjsz_deploy
  StrictHostKeyChecking no
```

若需要代理再加一行：
```
  ProxyCommand nc -X connect -x 127.0.0.1:18080 %h %p
```

之后直接 `git push` 就行。

### 2.4 完整流程

```bash
git clone git@github.com:19543687553-ai/ygjsz-ws.git /tmp/ygrepo   # 或已有仓库直接 cd
cd /tmp/ygrepo
cp /path/to/server.mjs ./server.mjs

git add -A
git -c user.name="ygjsz" -c user.email="ygjsz@local" \
    commit -m "fix(battle): 6 人房 + 主线推进 + GM 指令补全 + 维护模式拦截"

GIT_SSH_COMMAND="ssh -o StrictHostKeyChecking=no -o ProxyCommand='nc -X connect -x 127.0.0.1:18080 %h %p' -p 443" \
    git push origin main
```

提交作者身份用 `-c user.name/-c user.email` 临时指定，**不要改全局 git config**。

### 2.5 推送后验证

```bash
sleep 25
curl -s https://ygjsz-ws.19543687553-ai.deno.net/health
# 新版本会有 maintenance 字段
```

---

## 3. 提交约定

- 提交信息用中文 + 前缀：`fix(...)` / `feat(...)` / `docs(...)` / `chore(...)`。
- 一次提交只做一件事，方便回滚。
- **千万不要提交**：
  - `sy_api/state/*`（真实玩家存档、维护状态）
  - `sy_api/_config.php` 里的真实 token（如需提交，先替换成占位值）
  - SSH 私钥、`*.pem`、`*.key`
  - `node_modules/`、`chromeprof_*/`
- `remoteConfig/*.bin` 4MB 可以提交（PHP 部署需要），但注意 GitHub 单文件 100MB 限制。

### `.gitignore` 建议
```
node_modules/
chromeprof_*/
*.log
sy_api/state/*
!sy_api/state/.keep
__pycache__/
*.idsig
```

---

## 4. 另一条路：不用 SSH，用 HTTPS + Token

```bash
git remote set-url origin https://<用户名>:<PersonalAccessToken>@github.com/19543687553-ai/ygjsz-ws.git
git push origin main
```
PAT 在 GitHub → Settings → Developer settings → Personal access tokens 生成（勾 `repo`）。

> 缺点：token 会留在 shell history 和 `.git/config` 里。手机操作时注意别截图泄露。

---

## 5. 恢复 Deno 部署（如果项目被删/额度重置）

1. 新建 Deno Deploy 项目 → Deploy from GitHub → 选 `ygjsz-ws`。
2. Runtime Configuration：**Dynamic App** + Entrypoint `server.mjs`。
3. 环境变量：`PHP_BASE`、`TOKEN`（与 PHP `_config.php` 一致）、`PLAYER_ID`、`VERBOSE=0`。
4. 拿到新域名后，改 PHP `_config.php` 的 `ws_host`。
5. `curl /health` 确认 `tables > 0`。

### 换到 VPS（避免免费额度耗尽）
`server.mjs` 用的是标准 `Deno.serve` + WebSocket。迁 Node 需要：
- `Deno.serve` → `http.createServer` + `ws`（或 `hono/node-server`）
- `Deno.env.get` → `process.env`
- `EdgeRuntime.waitUntil` → 直接 `void promise`
- `Buffer` 已经是 `node:buffer`，不用改
其余协议逻辑零改动，约 30 分钟。
