# dsh-ios

[English](README.md) | **中文**

在**越狱 iPhone** 上跑 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（`dsh`）——
**不需要 Mac、不需要 Xcode、不需要交叉编译。**

## 快速开始

**⚠️ 先确认一件事：你现在能从这台电脑 SSH 连上手机吗？**

* **能** —— 往下走。下面的命令会自动找到手机、提示你输密码，**通常就这三行**。
* **不能** —— **先看[安装](#安装)那一节**：手机要越狱、装 OpenSSH（Sileo 里的
  `openssh-server`）；电脑上要有 SSH 客户端 —— 有 PuTTY 就用 PuTTY，没有就用系统自带的那个，
  **两种都不用下载**。**脚本装不了手机那一半** —— 通往手机的 SSH 通道，末端是手机上的 `sshd`。
  **连通了再回来。**

**确认能连之后，最快的用法：让手机和电脑连同一个 Wi-Fi，然后跑这三行。**

```sh
git clone https://github.com/XLPOISTOP-prog/dsh-ios.git
cd dsh-ios
./bootstrap.sh
```

> **懒得下载 PuTTY，或者不会用？那就不用。** 装了 PuTTY 就用 PuTTY；没装就自动退回
> **你电脑上本来就有的 `ssh`**（Git Bash 自带一个，Windows 10/11 自己也带一个），
> 并且在同一个 Wi-Fi 里自动找到手机。**两种都不需要你装任何东西 —— 同一个 Wi-Fi，一条命令，输一次密码。**

> ⚠️ **但有一种情况例外，而且很重要：如果你电脑上开着代理 / VPN —— Clash、Surge、Meta、
> sing-box 这类，尤其是 TUN 或全局模式 —— 请一定要用 PuTTY。** 这类工具会把**去往局域网的
> 流量一起接管**，等于在你和手机之间又多了一层东西。同一台机器上连续测 20 次连接：
> **plink 20/20**、自带 `ssh` **17/20** —— **测了两次（代理关着、开着各一次），失败位置完全相同**，
> 每次都是 `Connection timed out during banner exchange`，**连认证都没走到**。
> 脚本会检测代理，**只要你正在用自带的 `ssh` 就会主动警告你**。

**不用查 IP、不用给参数。** 脚本会自己找手机 —— 先看 `127.0.0.1` 上有没有 USB 转发的
SSH 通道，没有就**扫你电脑所在的每一个局域网段**（读 SSH banner，不是简单看端口开没开）——
**然后提示你输入密码**，就是越狱时设的那个（没设过的话默认是 `alpine`）。

> 第一次不放心的话，在最后一行加个 `--dry-run` 先看一眼 ——
> 它只打印打算做什么、**不改任何东西**；但它**照样会连手机、照样会问密码**，
> 因为计划是依据手机上已装了什么算出来的。它在手机上跑的**全是只读命令**。

**自动查找到底覆盖什么**（它只能找到它找过的地方）：

* **只找三段私有地址** —— `192.168.x.x`、`10.x.x.x`、`172.16~31.x.x`；而且是**你电脑上的
  每一个地址各扫一个 `/24`**（第二块网卡、带自己 `10.x` 地址的 VPN 都算上，避免扫错网段、
  然后误报"没找到手机"）；
* 端口 **22**，或者 `--port` 指定的那个。22 是 OpenSSH 的默认值，越狱设备上的原版
  `openssh-server` 配置里 `Port 22` 是注释掉的 —— 注释掉就等于用默认值。**有些越狱还会
  多开一个端口**：这套东西开发所用的那台设备，launchd 里就同时开了 **2222**；
* 如果手机**不在这台电脑所在的网络**（访客 SSID、蜂窝数据）、或者局域网比 `/24` 大而手机
  不在你电脑这一段里、或者 sshd 用的是非默认端口而你没给 `--port` —— 这些都找不到。
  这几种情况自己给地址：`--device mobile@<手机IP> --port <端口>`。

### 手动指定连接方式

上面的自动查找覆盖不了所有情况 —— 想自己指定，或者自动扫描失败时：

| 你的连接方式 | 加什么参数 |
|---|---|
| **Wi-Fi（同一局域网）** | `--device mobile@<手机IP>`，IP 在手机「设置 → 无线局域网」里看 |
| **i4Tools 的「打开 SSH 通道」** | `--device mobile@127.0.0.1` —— 它把手机的 22 端口通过 USB 转发到**你电脑的** 22 端口 |
| **`iproxy`**（libimobiledevice） | `--device mobile@127.0.0.1 --port <你转发到的端口>` |
| **其他隧道** | `--device mobile@<主机> --port <端口>` |
| **不想在命令行里给密码** | 不给 `--password`，脚本会提示输入（不回显） |

| 参数 | 含义 |
|---|---|
| `--device 用户名@主机` | **怎么连到手机。** `mobile` 是**手机上的账号名**（iOS 固定有 `root` 和 `mobile` 两个，用 `mobile` —— `root` 登录通常是关着的）。不给就自动找。 |
| `--password <密码>` | **手机**上 `mobile` 账号的密码 —— **越狱成功时让你设置的那个**。不给就提示输入；没设过的话 OpenSSH 默认是 `alpine`。 |
| `--dry-run` | 只打印打算做什么，**不改任何东西**。仍然会连手机、仍然要密码 —— 计划依赖手机上已装了什么。 |
| `--key <文件>` | 用 SSH 私钥而不是密码。 |
| `--port <端口>` | SSH 端口。默认 22，也就是 OpenSSH 自己的默认值。自动扫描也用这个端口。 |
| `--push-only` | 只把仓库推过去就停：不装 Node、不装 DSH 树、不跑 `install.sh`、不重启。用来验证传输是否通。 |
| `--transport putty\|openssh` | 强制用哪个 SSH 客户端。默认装了 PuTTY 就用 PuTTY，没装就用自带的 `ssh`。 |
| `--hostkey <指纹>` | 固定主机密钥（默认首次连接时自动学习）。 |

> **脚本不依赖 i4Tools。** `127.0.0.1` 只是它探测的其中一种情况，
> 走 Wi-Fi 直连或者别的转发工具都行。

**然后 `bootstrap.sh` 会自己把剩下的做完：**

1. 检查手机 —— 越狱、`jbroot`、`ldid`、`tar`，以及 Node 和 DSH 树在不在
2. Node 缺 → 下载钉死的构建、**校验 sha256**、推过去
3. DSH 树缺 → **在你电脑上** `npm install`（npm 和快网络都在这边）、打包、推过去
4. 推仓库内容 → 在手机上跑 `install.sh` → 启动
5. 打印一个 `http://127.0.0.1:3080/?token=…`

**最后**在**手机的 Safari** 里打开那个 URL，把权限模式设为**完全权限** ——
`workspace-write` 在 iOS 上没有可用的沙箱后端。

**脚本要能跑通，手机上需要：** 越狱、[NewTerm](https://repo.chariz.com/)、
Sileo 里的 **`openssh-server`**、以及 `ldid` + `tar`。
**电脑上需要：** 一个 SSH 客户端 —— **有 PuTTY（`plink`+`pscp`）就优先用它**，
没有就用 Git for Windows、WSL、macOS、Linux、Windows 10/11 自带的 `ssh`+`scp`。**两种都不用下载。**
下面的[安装](#安装)章节有完整步骤 —— 包括**为什么 i4Tools 在没装 OpenSSH 时也报「成功」**。

**只在 iPhone 15 / iOS 17.1.1 / Relaxin（rootHide）上测过。**
换环境之前，先看下面「先读这段，别默认它能用在你的系统上」那一节。

```
┌─────────────────────────────────────────────┐
│  Safari → http://127.0.0.1:3080             │
│    dsh Web UI、工作区、会话、轨迹            │
├─────────────────────────────────────────────┤
│  dsh                                        │
│    插件树 · agent loop · 工具               │
├─────────────────────────────────────────────┤
│  Node 22（现成的 iphoneos-arm64 构建）      │
│    --jitless · 预加载 JS 垫片               │
├─────────────────────────────────────────────┤
│  iOS 17 / 已越狱                            │
└─────────────────────────────────────────────┘
```

实测环境：**iPhone 15（A16）、iOS 17.1.1、Relaxin（rootHide）**，**Node 22.19.0**。

<table>
<tr>
<td width="50%"><img src="docs/screenshots/dsh-web-ui.png" alt="在 iOS Safari 里运行的 DSH Web UI"></td>
<td width="50%"><img src="docs/screenshots/settings.png" alt="DSH 设置面板，权限模式为完全权限"></td>
</tr>
<tr>
<td align="center"><em>DSH 自己的 Web UI，跑在手机的 Safari 里。<br>会话列表、工作区选择、模型选择 —— 真的在跑，<br>不是效果图。</em></td>
<td align="center"><em>设置面板，权限模式设为「完全权限」。<br>这里是必须的：<code>workspace-write</code> 在 iOS 上<br>没有可用的沙箱后端，无法启动任务。</em></td>
</tr>
</table>

服务只监听 `127.0.0.1:3080`，不对外暴露。桌面版 DSH 会自动开浏览器；
这里传 `--no-open`，改为打印 URL，且每次启动 token 都会变。

### ⚠️ 先读这段，别默认它能用在你的系统上

**只在一种配置上开发和验证过，其他组合一概没测：**

| | |
|---|---|
| 手机 | iPhone 15（A16） |
| iOS | **只有 17.1.1** |
| 越狱 | Relaxin（rootHide） |
| Node | 22.19.0（`iphoneos-arm64`） |

这个移植依赖的机制 —— jbroot 命名空间分裂、原生模块的 `mmap` 限制、
`--jitless` 的行为、没有 `gzip` —— 都是**平台性质**，不是某个 iOS 版本特有的，
所以**思路**应该能迁移过去。**但那是推理，不是证据。**

换 iOS 版本、换手机、换越狱工具，就要**重新验证细节**。
请把 [`docs/ios-constraints.md`](docs/ios-constraints.md) 当成
**一份待核对清单**，而不是「保证成立」。

特别注意：**rootless 越狱**（Dopamine 一类）**不会有**这里描述的 jbroot 分裂 ——
命名空间那一节是 rootHide 布局特有的。

### 实用提示

**手机上需要终端。** 本项目是用 [NewTerm](https://repo.chariz.com/) 构建和使用的。
其他 POSIX shell 应该也行；脚本只假设有 `sh`，不依赖别的。

**从电脑连 SSH 不是必需的，但是最省时间的一件事。** 只用 NewTerm 也能跑通全部流程。
SSH 改变的是**调试速度**：用 `pscp`/`scp` 传文件而不是手敲、直接跑命令读输出而不用
一个字一个字转录、不用在 App 之间来回切。这个移植就是在 SSH 上调出来的，
**差距不是一点半点**。

**手机上必须装 SSH 服务端** —— 越狱源里的 **OpenSSH**。这一点绕不过去：
任何客户端（包括 i4Tools 那个通道）最终连的都是**手机上的 `sshd`**。
i4Tools 的方便之处在于它**走 USB（usbmuxd）转发本地端口**，所以不需要手机 IP 或 Wi-Fi ——
但它是**转发器，不是服务端**。**卸掉 OpenSSH 之后它会报 `Connection refused`，
而 i4Tools 界面上仍然显示「成功」** —— 因为那个弹窗只说明隧道建好了，不说明有人应答。

**token 只需要用一次。** Safari 会把 `?token=…` 种下的 cookie 存下来，
所以**第一次用完整 URL 打开之后，以后直接输 `127.0.0.1:3080` 就行**。
这点值得知道 —— 因为 token 每次启动都变、而且长到手打很烦；
**也正因如此，一个过期的书签看起来会像「服务挂了」。**

---

## 安装

两个入口。**命令就在上面的[快速开始](#快速开始)里** ——
这一节讲的是「跑那条命令之前需要具备什么」，以及每个脚本到底做了什么。

### 桌面端一条命令

`bootstrap.sh` 会检查手机、拉 Node、**在你电脑上构建 DSH 树**（npm 和网络在这边，不在手机上）、
全部推过去、适配、启动。

**幂等**：已经有的东西不动。其余参数看 `--help`
（`--key`、`--hostkey`、`--install-dir`、`--skip-node`、`--skip-dsh` …）。

#### 先把零件凑齐

**手机上** —— 这些必须先有，本仓库装不了：

1. **越狱。** 测试环境见[致谢](#致谢)。
2. **[NewTerm](https://repo.chariz.com/)** —— 你实际敲命令用的终端。
3. **OpenSSH** —— Sileo 里的 `openssh-server`。**远程操作时这不是可选项**：
   任何 SSH 客户端（**包括 i4Tools 那个通道**）最终连的都是**手机上的 `sshd`**。
   卸掉它，通道会报 `Connection refused`，**而 i4Tools 的弹窗照样显示「成功」**。
4. **`ldid`** 和 **`tar`** —— 绝大多数 bootstrap 都自带。`which ldid tar` 查一下。

**电脑上** —— 只需要一个 SSH 客户端：

| 平台 | 用什么 | 说明 |
|---|---|---|
| **Windows，装了 PuTTY** | `plink.exe` + `pscp.exe`（[下载](https://www.chiark.greenend.org.uk/~sgtatham/putty/latest.html)，或从 *Alternative binary files* 单独拿） | **有就优先用它** —— 密码当参数直接传进去，中间不隔任何东西。 |
| **Windows，没装 PuTTY** | **本来就装好的 `ssh`/`scp`** —— Git Bash 自带，Windows 10/11 自己在 `C:\Windows\System32\OpenSSH` 里也有 | **什么都不用下载。** 而且跑这个脚本用的就是 Git Bash。 |
| Linux / macOS | `ssh` + `scp`，要传密码再装 `sshpass` | 或者用密钥：`--key` |
| WSL | 同 Linux | |

两种都行 —— **装了 PuTTY 就用 PuTTY，没装就用自带的 `ssh`**。

**⚠️ 但只要这台电脑上开着代理 / VPN，就用 PuTTY。** 透明代理 —— Clash、Surge、Meta、
sing-box、以及各种 TUN 模式 —— **会把去往局域网的流量一起接管**，而系统自带的 `ssh`
正是最先扛不住的那个。同一台机器上连续测 20 次连接：**plink 20/20**、自带 `ssh` **17/20**；
**测了两次（一次没代理、一次代理开着），失败位置完全相同**（第 6、12、18 次），
每次都是 `Connection timed out during banner exchange` —— **连认证都没走到**。
所以这个毛病**本身不是代理造成的**，代理只是又一个可能挡在通往手机路上的东西。
**"自带 `ssh` + 开着代理"才是最该避开的组合。**

脚本会检测代理（Wintun/TAP 网卡，或 `198.18.x.x` 这类 fake-IP DNS），
**只要你正在用自带的 `ssh` 就会警告你**；任何一次连接失败它也都会自动重试两次。

唯一的区别是密码怎么交进去：
**它永远不出现在命令行上**，而 Windows 又没有 `sshpass`，所以脚本会写一个极小的
`SSH_ASKPASS` 助手（放在临时目录里、退出时删除 —— **密码本身走环境变量，不落盘**），
然后让 OpenSSH 去调它。这需要 OpenSSH 8.4 以上的 `SSH_ASKPASS_REQUIRE=force`；
Git for Windows 和 Windows 10/11 都远在这之上。更老的 `ssh` 上脚本会明确告诉你，
代价只是**每连一次问一次密码**。

脚本会在 `PATH`、常见安装位置、以及 `%TEMP%` / `%USERPROFILE%` / `~/Desktop`
下的 `plink/` 目录里找 PuTTY —— **解压版 PuTTY（而不是跑安装程序）通常就落在这些地方**。
想直接指定路径、或者强制用某一种：

```sh
PLINK=/path/to/plink PSCP=/path/to/pscp ./bootstrap.sh --device ...
./bootstrap.sh --transport openssh --device ...    # 或者 --transport putty
```

**怎么连到手机**，两条路：

* **i4Tools 的「打开 SSH 通道」** —— 走 USB 转发本地端口，**不需要手机 IP 或 Wi-Fi**。
  它监听 `127.0.0.1:22`，正是脚本的默认值。**重装 OpenSSH 之后要重新点一次。**
* **Wi-Fi** —— `--device mobile@<手机IP>`，IP 在 设置 → 无线局域网 里看。

### 已经装好 Node + DSH？只做适配

前置：**已越狱**手机，且已有 **Node 22**、`ldid`、`tar`。

```sh
git clone https://github.com/XLPOISTOP-prog/dsh-ios.git
cd dsh-ios
sh install.sh
```

`install.sh` **幂等**，支持 `--dry-run`。它会：

1. 定位 DSH 树（找不到就报错，**不猜**）
2. 装原生模块替身
3. 把纯 JS 图片编解码器**覆盖**进 `node_modules/sharp`
4. 装纯 JS ripgrep 替代
5. 复制三个改过的 DSH 文件
6. 改写 `pty.node` / `system.node` 的 Mach-O 平台字节并重签名
7. 往前端 `index.html` 注入浏览器 polyfill

然后：

```sh
sh scripts/start.sh          # 打印一个 Safari URL
```

`scripts/start.sh` 处理了这台手机上**最容易出错的部分** ——
为什么这么写，见 [`docs/jbroot-namespaces.md`](docs/jbroot-namespaces.md)。
停止用 `scripts/stop.sh`。

### 参数

```sh
sh scripts/start.sh 3081        # 换端口
DSH_SAFE=1 sh scripts/start.sh  # 不杀无关 node 进程
```

---

## 为什么这条路线不一样

**已经存在另一个 iOS 移植，而且做得很扎实**：它交叉编译 Node 并打了 V8 补丁，**完整 JIT 可用**，原生编译了 `node-pty`，还交付规范的 `.deb` 包。**如果你有 Mac 和 CI，就用那个** —— 它更快、更完整。

这个移植做的是**相反**的取舍：拿一个**现成的** iOS Node 构建，**在运行时适配**。所以整个移植就是一组 JS 垫片、**一处字节级二进制补丁**、以及**三处对 DSH 的小改动**。**任何人拿一台越狱手机 + 一条 SSH 就能复现 —— 零编译工具链。**

这个约束就是全部设计：

| | 本项目 | 交叉编译移植 |
|---|---|---|
| 编译工具链 | **无** | macOS + Xcode（+ CI） |
| JIT | 无（`--jitless`） | **有** |
| Node | 现成 `iphoneos-arm64` 构建 | 自建 + V8 W^X 补丁 |
| `node-pty` | macOS prebuild，改一个字节 | 为 iOS 编译 |
| ICU / Unicode 正则 | 取决于构建 | small-icu，`\p{...}` 可用 |
| 图片（`sharp`） | **纯 JS 编解码器（可用）** | shim（文档中标为不可用） |
| 交付 | 脚本 | `.deb` 包 |

**两者互补，不是竞争。** 想结合的话，注意事项在
[`docs/ios-constraints.md`](docs/ios-constraints.md)。

---

## 能用的

| 能力 | 状态 |
|---|---|
| Safari 里的 Web UI（工作区、会话、多轮、轨迹） | ✅ |
| 实时 DeepSeek API，流式 SSE | ✅ |
| `bash` —— 真实命令执行 | ✅ |
| `read` / `write` / `edit` | ✅ |
| `glob` / `grep` | ✅ 纯 JS ripgrep，**进程内调用** |
| **图片附件 —— 上传与读取** | ✅ **纯 JS `sharp` 后端** |
| 会话持久化（`jsonl.zstd`） | ✅ |
| 子 agent、workflow、goal、todo、web 搜索 | ✅ |

## 不能用的

| 限制 | 原因 |
|---|---|
| 无 JIT | `--jitless`；同样工作量大约要**多一个数量级**的 CPU |
| 无 WebAssembly | 被 stub；依赖 wasm 的库跑不了 |
| 沙箱 / FFI 子进程 | `koffi` 没有 iOS 构建；已替身 |
| `worker_threads` | 这套 flag 下不可用 |
| 原生 npm addon | 需要 iOS 构建；DSH 依赖的那两个已特殊处理 |

---

## ⚠️ 我们踩过的坑

**这些是整件事里最耗时间、也最没有公开资料的部分。**
完整展开（含观察命令和走过的弯路）在
[`docs/ios-constraints.md`](docs/ios-constraints.md) 和
[`docs/jbroot-namespaces.md`](docs/jbroot-namespaces.md)。

**在这个平台上调试任何东西之前，先读这张表。**

### 文件系统 —— 最大的坑

| 坑 | 实际发生了什么 |
|---|---|
| 🔴 **`/var/mobile` 有两个不同的含义** | **越狱的 shell**（NewTerm 的 `zsh`、`tar`、`ldid`）把它解析到 **jbroot 内部**；而**我们的 Node**（原生 iOS 构建，**没有链接 rootHide 的路径重定向**）把它解析到**真实根**。**两个都对，但它们不一致。** 于是把绝对路径 `/var/mobile/...` 交给 Node，会解析到一个**根本没有你文件**的目录。<br>**正确做法：先 `cd` 进去，再传相对路径。**<br>这一个原因单独造成了 `--import` 失败、模块解析失败、配置路径失效、UI 行为异常 —— 而且**被我误诊为「沙箱问题」好几天**。 |
| 🔴 **原生 `.node` 模块必须放在 jbroot 里** | 同一个文件、同一个签名：**从 jbroot 加载正常**，从真实 `/var/mobile/Documents` 加载则报<br>`file system sandbox blocked mmap()`<br>给 Node 加 `no-sandbox` entitlement **无效** —— 限制在**进程所在的沙箱**上，不在它请求什么。<br>**这就是为什么安装不能放在「退出越狱也保留」的位置。** |
| **软链 addon 目录不管用** | `prebuilds/ios-arm64 → darwin-arm64` 会被 loader 跟随，然后它**照样拒绝**那个 macOS 文件。**必须是真实拷贝。** |
| 🟠 **`spawn` 返回 `ENOENT` 不代表「禁止启动子进程」** | 它的意思是**「这个路径在本进程的视图里不存在」**。真实的 `/bin` 里只有 `df` 和 `ps` —— **所有越狱二进制都在 jbroot 下**。<br>只要 `PATH` 指向真实路径，`child_process` **完全正常**。<br>**这个 errno 被我误读成沙箱拒绝，导致整条架构走错了一段时间。** |
| **exec 一个「脚本」不可靠** | 启动**二进制**没问题。启动**脚本**（内核要去解析 `#!/…` 解释器路径）**不行** —— shell 路径、Node 的 realpath、`#!/usr/bin/env node` 配 PATH，**全都试过，全都不行**。内核视图和进程视图**无法同时满足**。<br>**规则：如果答案涉及 exec 一个脚本，就去找进程内的答案。** |
| **没有 `gzip`** | `tar` 有，`gzip` 没有。`tar -xzf` 会报 `gzip: cannot exec`。<br>用 Node 的 `zlib` 解压。 |

### 进程管理

| 坑 | 实际发生了什么 |
|---|---|
| 🟠 **`pkill -f` 静默无效** | 它**返回成功但什么都没杀**。旧实例继续占着端口，下一次启动**看起来成功了**，实际死于 `EADDRINUSE`。<br>用 pidfile；`killall node` 作为**故意的无差别兜底**；判断端口是否空闲**只能自己 bind 试试** —— 这台手机上**没有 `lsof`、`ss`、`netstat`，连 `ps` 都没有**。 |
| **`su` 是 BSD 版** | 不支持 `-c`。root 的 SSH 登录默认被拒。 |

### DSH 自身容易被误读的行为

| 坑 | 实际发生了什么 |
|---|---|
| 🔴 **禁用 `shell-env` 会破坏会话创建** | 出厂 `standard` agent preset 里声明了一行 `tool-bash`，它注入 `shellEnv`。`shell-env` 一关，**preset 挂不起来 → 创建会话失败 → 工作区选择器静默退回默认**，而且**服务端日志里一个字都没有**。<br>**profile 启动时审计不到** —— preset 是**创建会话时才懒挂载**的。 |
| 🟠 **禁用某一行会静默移除一个服务** | 启动审计**会跳过被禁用的条目**，所以 `subprocess` 服务就这么无声无息地消失了，后续依赖它的东西全部挂住。 |
| 🟠 **错误会被吞掉** | 选择器的处理函数抛了异常，被某处 catch 掉了：**没有日志、屏幕上也没有任何提示**。<br>[`tools/diag-overlay.js`](tools/diag-overlay.js) 就是为此写的 —— 它在**一次页面加载**里就定位了真因，而我之前已经猜了好几轮。<br>**先造仪器，再提假设。** |
| 🟠 **请求图缓存不随像素预算失效** | 提高预算**对已经发过一次的图完全无效** —— 复用的还是旧的小尺寸编码。<br>要 `rm -rf dsh-home/attachments/v1/request-images/`。<br>**极易被误读成「改动没生效」。** |
| **缓存版本标记覆盖不全** | 为 WebP→PNG 那个修复 bump 过一次，但**不覆盖预算改动**。**别假设改配置会失效任何缓存。** |

### 运行时

| 坑 | 实际发生了什么 |
|---|---|
| **没有 JIT，因而也没有 WebAssembly** | undici（Node 的 `fetch`）在**导入时**就用 WebAssembly 编译它的 HTTP 解析器 —— 所以 **`fetch` 根本加载不起来**。 |
| **给 `globalThis.fetch` 赋值会触发 undici 加载** | 这个全局量是**懒加载 getter**，赋值前的「读」才是触发导入和崩溃的那一步。<br>要用 `Object.defineProperty` **定义**它，而不是赋值。实测手机上**两个 preload 按顺序都要**。 |
| **ripgrep 既无法 spawn，包也不存在** | `ripgrep-ios-arm64` **从未发布**；`darwin-arm64` 构建链接了 iOS 没有的 `libiconv.2.dylib`。<br>改用**纯 JS 实现 + 进程内调用**。 |
| **`sharp` 在 iOS 上没有可行路径** | 没有 iOS 版 libvips。<br>改用**纯 JS 编解码器** —— 而这恰好是另一个交叉编译移植**明确列为不可用**的能力。 |
| 🔴 **自测通过，产物却是坏的** | 我们**自己的解码器忽略了** JPEG 的 `SOF0` 段长字段，所以它把我们编码器的 bug 高高兴兴读了回来，**所有自测全绿** —— 而 API 拒绝每一个文件。<br>**要拿产物去对规格，而不是对你的自家读取器。**<br>[`fixtures/verify-image-codec.mjs`](fixtures/verify-image-codec.mjs) 就是干这个的。 |

---

## 难点是怎么解决的

下面每一条都是**承重的**。推理过程和**试过但失败的路**都在
[`docs/ios-constraints.md`](docs/ios-constraints.md)。

### 无 JIT 的 V8，以及 `fetch`

`--jitless` 意味着没有 WebAssembly，而 Node 的 `fetch` 是 undici —— 它的 HTTP 解析器是
**在导入时**编译的 WebAssembly 模块。所以 **`fetch` 根本加载不起来**。

两个 preload，按顺序：

1. **`preload/wasm-polyfill.js`** —— 提供 `WebAssembly` 全局量，让 undici 能导入完
2. **`preload/fetch-https-shim.js`** —— 用 `node:http`/`node:https`（原生解析器）**替换整个 `globalThis.fetch`**

**两个都需要。** 注意 shim 是用 `Object.defineProperty` 安装的，不是赋值 ——
`globalThis.fetch = …` 会触发 Node 的懒加载 getter，进而加载 undici，那就是崩溃点。

### 图片：纯 JS 的 `sharp`

iOS 上没有 libvips，`sharp` 无从谈起。`sharp-ios/` 是从零实现 DSH 用到的那部分：

```
exif.cjs     EXIF 方向
png.cjs      PNG 解码 + 编码（zlib、反滤波、CRC）
jpeg.cjs     JPEG 解码（Huffman；baseline / extended-sequential /
             渐进式；restart interval）与编码
resize.cjs   重采样
sharp.cjs    模拟 sharp 链式 API 的入口
```

**五个文件，除 `node:fs` / `node:zlib` 外零依赖，完全自包含。**

它是作为**覆盖层**安装的：`npm install sharp` 提供包本体，然后把关键的那个文件
`dist/index.cjs` 改成转调：

```js
// Package entry (CommonJS). Pure-JS implementation; see ./ios/sharp.cjs.
module.exports = require('./ios/sharp.cjs');
```

**盲测验证过**：一张**内容随机生成、从未向模型描述过**的图，被准确读了回来 ——
精确的字符串、形状、以及**两个颜色**。

**为什么「颜色」是关键证据**：早先的权宜做法是让 agent 手工解码 PNG 再渲染成字符点阵。
那个方式能表达形状，**但完全无法承载颜色**。当模型正确报出颜色时，同时证明了两件事：
**像素是真的被解码了**，而且**它们是以图像形式送到模型的，不是文本**。

### 没有 ripgrep 的 `glob` / `grep`

`dsh-tool-fs-search` 会解析 `@vscode/ripgrep-<platform>-<arch>` 然后 spawn 它。
`ripgrep-ios-arm64` 从未发布，`darwin-arm64` 构建又链接了 iOS 没有的
`/usr/lib/libiconv.2.dylib`。

`rg-ios/` 是用纯 JS 实现该插件**实际使用的两种调用形态** ——
glob 用 `--files`，grep 用 `--json`（ripgrep 公开的 JSON schema）——
所以**原有解析器一行都不用改**。它是**进程内调用**的，不是 spawn：
在这台手机上 spawn 脚本不可靠，因为内核解析 shebang 时用的是
**与创建它的进程不同的文件系统视图**（见命名空间文档）。

### `node-pty`：一个字节

现成的 macOS prebuild 被 dyld 拒绝，报 `have 'macOS', need 'iOS'` ——
这个判断取决于 `LC_BUILD_VERSION` 的 **`platform` 字段**，与签名和架构都无关。
`tools/patch-macho-ios.mjs` 就改写那**一个字节**（`1` → `2`），再用 `ldid` 重签。
**不编译、位精确、可轻松回退。**

### 文件系统命名空间

**耗时最多的单个问题，也是别处最缺文档的一个** —— 完整版（含观察命令）在
[`docs/jbroot-namespaces.md`](docs/jbroot-namespaces.md)。两条最要紧的结论：

* 给 Node 传**相对**路径（先 `cd`），**不要**传 `/var/mobile/...`
* 原生 `.node` 模块**必须放在 jbroot 内** —— iOS 沙箱阻止从真实
  `/var/mobile/Documents` `mmap()` 可执行代码

---

## 目录结构

```
install.sh                  幂等安装器
sharp-ios/                  纯 JS 图片编解码器（5 文件 + 文档）
rg-ios/                     纯 JS ripgrep 替代
preload/                    运行时垫片：WebAssembly、fetch、浏览器 polyfill
shims/                      原生模块替身：koffi、win32-process、flock
patched/                    三个改过的 DSH 文件 + 改了什么、为什么
tools/                      Mach-O patcher、浏览器诊断横幅
scripts/                    start / stop / 配置
  └── legacy/               被取代的旧脚本（只读，别跑）
fixtures/                   测试图 + 自测脚本
docs/                       三份长文设计笔记
```

---

## 已知缺口

* **没有补 `User-Agent` 可能被拒。** `node:http` 默认不带 UA，有些 API 网关会把无 UA 的调用
  当机器人拒掉。交叉编译那个移植报告过 `401 governor`，通过在其 fetch shim 里加
  `user-agent: node` 解决。**本项目的 shim 没有做这件事。** 如果遇到别处正常、这里莫名 401，
  第一个就查这个。
* **请求图缓存不认像素预算。** 改 `DEFAULT_REQUEST_IMAGE_PIXEL_BUDGET` 对已发过的图无效，
  要清 `dsh-home/attachments/v1/request-images/`。
* **多数越狱 Node 包不带 `npm` CLI** —— 可能得从开发机拷 `node_modules`。
* **提高图片预算是要付代价的**：图像 token 大致翻倍。

## 致谢

站在这些之上：

* **越狱本身。** 这个项目完全是它的下游产物。这个移植之所以可能存在，
  只是因为你可以在自己的手机上运行一个不受沙箱限制的二进制 ——
  而那是很多人花时间做出来的：
  * **[Relaxin](https://github.com/owngoal-dev/Relaxin)**（MIT）—— 本项目构建和
    验证所基于的越狱（iOS 17.1.1）。仓库里放的是参考实现源码。
  * **[roothide Bootstrap](https://github.com/roothide/Bootstrap)**（MIT）——
    iOS 15–17 的 `roothide` 引导程序。它提供 jbroot 机制，也就是
    [`docs/jbroot-namespaces.md`](docs/jbroot-namespaces.md) 花了两百行去理清的东西。
    本仓库里关于路径、`mmap`、`dlopen` 的**每一条结论都是那个设计的后果** ——
    而且一旦理解了，你会发现它是一个站得住脚的设计。
    它的[开发者文档](https://github.com/roothide/Developer)值得在动手写任何
    「要能扛过重新越狱」的东西之前读一遍。
  * **[Dopamine](https://github.com/opa334/Dopamine)**（opa334）以及它确立的
    rootless 路线 —— 现在整个生态大多建立在这个思路上，包括上面的 roothide 系列。
  * **[Procursus](https://github.com/ProcursusTeam/Procursus)** —— 提供 bootstrap 用户态，
    也就是这个安装器依赖的 `ldid`、`tar`、`zsh`。

  **这些都不是小事，而且都不是有偿的。**
* [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) —— MIT
* [Cordis](https://github.com/cordiverse/cordis) —— DSH 的插件框架
* **[`j0shua-SYSON/node-ios`](https://github.com/j0shua-SYSON/node-ios)**（MIT）——
  **没有它就没有这个移植。** 项目自述是「the first public Node >=20 build for iOS」，
  也正是本项目构建和测试所基于的 Node。它的 release 说明里推荐的
  **正好就是我们依赖的 `--jitless`** —— 这点值得知道：
  **那个 flag 不是本项目发明的权宜之计，而是这个平台唯一公开构建的预期用法。**
  校验和已固化在 [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md)。
* **交叉编译的 iOS 移植**（[`ddddddedcds/deepseek-harness-ios`](https://github.com/ddddddedcds/deepseek-harness-ios)
  `ios-port` 分支，及其配套的 [`Node.js-for-ios`](https://github.com/ddddddedcds/Node.js-for-ios)）。
  **它的 `docs/ios-port.md` 是这个问题上最有价值的单篇文档**，本仓库
  `docs/ios-constraints.md` 里若干条笔记正是因为读过它才存在。本移植在「如何构建 Node」
  上选了相反的路线，但对「iOS 禁止了什么」的诊断有大量重合，**这一点归功于那项工作**。
* [`everettjf/dsh-ios`](https://github.com/everettjf/dsh-ios) —— 另一个同样合理、
  思路完全不同的方案：在手机上用 iSH 模拟 Linux 来跑 DSH。
  **GPL-3.0；本项目未使用其任何代码。**

## 许可

MIT —— 见 [`LICENSE`](LICENSE)。第三方组件及其条款列于
[`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md)。
