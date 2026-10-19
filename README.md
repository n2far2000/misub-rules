# misub-rules

[![Update rules](https://github.com/n2far2000/misub-rules/actions/workflows/update.yml/badge.svg)](https://github.com/n2far2000/misub-rules/actions/workflows/update.yml)
[![License: AGPL-3.0-only](https://img.shields.io/badge/license-AGPL--3.0--only-blue.svg)](LICENSE)

把 [Loyalsoldier/clash-rules](https://github.com/Loyalsoldier/clash-rules) 的规则集
转换成 [MiSub](https://github.com/imzyb/MiSub) 可直接引用的**规则模板（ini）**，
按其 README 公开推荐的**白名单模式**组织分流顺序。

每日由 GitHub Actions 自动重建，经 jsDelivr 分发到国内可直连的链接。

---

## 目录

- [这是什么](#这是什么)
- [快速开始](#快速开始)
- [可用链接](#可用链接)
- [四档预设](#四档预设)
- [为什么还要自己托管规则集](#为什么还要自己托管规则集)
- [与官方推荐配置的差异](#与官方推荐配置的差异)
- [本地模式](#本地模式)
- [验证](#验证)
- [工作原理](#工作原理)
- [常见问题](#常见问题)
- [目录结构](#目录结构)
- [许可与署名](#许可与署名)

---

## 这是什么

Loyalsoldier 的规则集面向 Clash 内核的 `rule-providers`，MiSub 的规则模板走的是
ACL4SSR 风格的 `ini`。两者之间不能直接对接，原因有三个（都是源码级事实，依据见
[docs/internals.md](docs/internals.md)）：

1. MiSub 的 ini 只认 `[custom]` 段里的 `ruleset=` 行；
2. MiSub 判定远程规则集的 `behavior` **只靠文件名白名单**，不在名单里的一律给
   `classical`，而 `classical` 要求 payload 是**完整规则语法**，喂裸域名会解析失败；
3. sing-box 渲染器只认 `.srs`（binary）或 **JSON**（source），Loyalsoldier 两者都不提供。

所以本项目做了两件事：**把上游数据重新表达成合规的规则集格式**，
**再把分流顺序按官方推荐的白名单模式写成 MiSub 模板**。

```
Loyalsoldier/clash-rules ──转换──▶ 本仓库 dist ──jsDelivr──▶ MiSub ──▶ Clash / sing-box
      (每日拉取)              (规则集 + ini 模板)        (引用模板)
```

产物规模：**10 张规则表 / 342,867 条规则**，每日重建，约 18 MB。

## 快速开始

### 方式一：引用远程模板 URL（推荐）

1. MiSub → **设置** → **规则与配置方案**
2. **规则来源** 选 **自定义远程规则 URL**
3. **模板配置** 填：

   ```
   https://cdn.jsdelivr.net/gh/n2far2000/misub-rules@dist/misub/Loyalsoldier_Full_MiSub.ini
   ```

4. 保存

MiSub 会在生成订阅时按需拉取，并按 `ETag` / `Last-Modified` 做条件请求。

### 方式二：粘贴为本地模板

1. 打开[完整版模板](https://cdn.jsdelivr.net/gh/n2far2000/misub-rules@dist/misub/Loyalsoldier_Full_MiSub.ini)，复制全文
2. MiSub → **自定义规则模板** → **新建模板** → 粘贴 → 保存
3. **规则来源** 选 **自定义规则模板**，选中刚保存的那份

> 本地模板只接受内容，单份上限 128 KB（完整版约 4 KB）。上游**结构**变化时需重新粘贴一次。

### 方式三：本地生成

```bash
git clone https://github.com/n2far2000/misub-rules
cd misub-rules
node scripts/loyalsoldier2misub.mjs --out-dir output --all-presets --verify
```

产物在 `output/misub-remote/`。详见[本地模式](#本地模式)。

> **客户端格式要对上**：`misub/` 与 `_clash.ini` 是 Clash/Mihomo 用的；
> sing-box 用户必须用 `_singbox.ini`。两者引用不同格式的规则集，混用会导致规则集下载后无法解析。

## 可用链接

所有产物发布在 **`dist` 分支**。

### 主链接（推荐）

| 预设 | 链接 |
|---|---|
| **完整版**（Clash / Mihomo） | `https://cdn.jsdelivr.net/gh/n2far2000/misub-rules@dist/misub/Loyalsoldier_Full_MiSub.ini` |
| **聚合版**（弱网 / 老设备推荐） | `https://cdn.jsdelivr.net/gh/n2far2000/misub-rules@dist/misub/Loyalsoldier_Agg4_MiSub.ini` |
| 标准版（Clash / Mihomo） | `https://cdn.jsdelivr.net/gh/n2far2000/misub-rules@dist/misub/Loyalsoldier_Standard_MiSub.ini` |
| 极简版（Clash / Mihomo） | `https://cdn.jsdelivr.net/gh/n2far2000/misub-rules@dist/misub/Loyalsoldier_Minimal_MiSub.ini` |

### 按内核区分

| 内核 | 完整版链接 | 聚合版链接 |
|---|---|---|
| Clash / Mihomo | `...@dist/misub-remote/Loyalsoldier_Full_MiSub_clash.ini` | `...@dist/misub-remote/Loyalsoldier_Agg4_MiSub_clash.ini` |
| sing-box | `...@dist/misub-remote/Loyalsoldier_Full_MiSub_singbox.ini` | `...@dist/misub-remote/Loyalsoldier_Agg4_MiSub_singbox.ini` |

### 历史链接（兼容保留）

旧版本使用 `SubBoost_*` 命名。这些路径**继续产出且内容与新链接完全一致**，
已有订阅无需任何改动：

| 旧链接 | 等价于 |
|---|---|
| `...@dist/misub/SubBoost_Full_MiSub.ini` | `misub/Loyalsoldier_Full_MiSub.ini` |
| `...@dist/misub/SubBoost_Standard_MiSub.ini` | `misub/Loyalsoldier_Standard_MiSub.ini` |
| `...@dist/misub/SubBoost_Minimal_MiSub.ini` | `misub/Loyalsoldier_Minimal_MiSub.ini` |
| `...@dist/misub-remote/SubBoost_Full_MiSub_clash.ini` | 对应 `_clash` 新链接 |
| `...@dist/misub-remote/SubBoost_Full_MiSub_singbox.ini` | 对应 `_singbox` 新链接 |

> 文件名里的 `SubBoost` 只是为保住链接而保留的**历史命名**，内容与 SubBoost 已无任何关系。
> 新配置建议直接用 `Loyalsoldier_*` 链接。

### 元信息

| 文件 | 内容 |
|---|---|
| `...@dist/manifest.json` | 构建时间、上游 commit、每张规则表的条目数、预设清单 |
| `...@dist/upstream.json` | 上游仓库与 commit |

**镜像前缀**：`cdn.jsdelivr.net` 不稳时可换成 `fastly.jsdelivr.net`、
`testingcf.jsdelivr.net` 或 `gcore.jsdelivr.net`。

> jsDelivr 对**分支引用**的缓存约 12 小时，产物更新后最长半天全网生效。

## 四档预设

| 预设 | 规则集数 | 策略组 | 条目 | 说明 |
|---|---|---|---|---|
| **Full** | 10 | 10 | 343,231 | 官方推荐白名单的完整实现，细分开关最全 |
| **Agg4** | **4** | 6 | 343,227 | 10 张表按策略组合并成 4 个文件，弱网 / 老设备推荐 |
| Standard | 6 | 6 | 342,889 | 去掉 iCloud / Apple / Google / Telegram 细分 |
| Minimal | 4 | 6 | 332,862 | 去掉全部 IP 表，国内直连靠 `GEOIP,CN` 兜底 |

> 条目数随上游每日变动，准确值以 [`manifest.json`](https://cdn.jsdelivr.net/gh/n2far2000/misub-rules@dist/manifest.json)
> 的 `presetsSummary` 为准。

**Full 的规则顺序**（严格复刻官方推荐）：

```
DOMAIN,clash.razord.top      → 🎯 全球直连      控制面板自身直连
DOMAIN,yacd.haishan.me       → 🎯 全球直连
private                      → 🏠 私有网络      DIRECT
reject                       → 🛑 广告拦截      REJECT
icloud                       → ☁️ iCloud        DIRECT
apple                        → 🍎 苹果服务      DIRECT
google                       → 🔍 Google        PROXY
proxy                        → 🚀 节点选择      PROXY
direct                       → 🎯 全球直连      DIRECT
lancidr                      → 🏠 私有网络      DIRECT
cncidr                       → 🎯 全球直连      DIRECT
telegramcidr                 → 📲 Telegram      PROXY
GEOIP,CN                     → 🎯 全球直连      DIRECT
FINAL                        → 🐟 漏网之鱼      PROXY（白名单语义：未命中即代理）
```

**注意**：`google` 排在 `direct` 之前。两个表都收录同一个域名时，**排在前面的一方获胜**。
这是官方推荐顺序，不要随意调换。

### Agg4 聚合版做了什么

把 10 张表按「目标策略组」合并成 4 个文件，只减少启动时的并发请求数，**规则条目一条不少**：

| 聚合文件 | 由哪些表合并 | 条目 | 目标策略组 |
|---|---|---|---|
| `agg-private.yaml` | private + lancidr | 150 | 🏠 私有网络 |
| `agg-ad.yaml` | reject | 194,969 | 🛑 广告拦截 |
| `agg-proxy.yaml` | proxy + telegramcidr | 27,257 | 🚀 节点选择 |
| `agg-direct.yaml` | direct + apple + icloud + google + cncidr | 120,851 | 🎯 全球直连 |

规则顺序与原版一致（`agg-direct` 内部比原表少 4 条，是 direct 表自身的重复项）：

```
DOMAIN,clash.razord.top       → 🎯 全球直连
DOMAIN,yacd.haishan.me        → 🎯 全球直连
private + lancidr             → 🏠 私有网络
reject                        → 🛑 广告拦截
proxy + telegramcidr          → 🚀 节点选择
direct + apple + icloud + google + cncidr → 🎯 全球直连
GEOIP,CN                      → 🎯 全球直连
FINAL                         → 🐟 漏网之鱼
```

- **收益**：客户端首次拉取从 10 个并发请求降到 4 个（少 6 次 TLS 握手，弱网下失败面更小）。
- **代价**：失去 iCloud / 苹果 / Google / Telegram 四个独立开关 —— 它们并入直连 / 代理组。
  这四组**默认值本来就相同**，所以不动这些开关的话分流行为完全一致。
- **不会省的**：下载字节数（gzip 前后都是 2.2 MB），因为本来就是同一批规则，只是重新装箱。

> 为什么不合成 1 个文件：一个 rule-provider 只能绑定一个策略组（payload 不带 policy），
> 硬合并会让第一条规则吃掉全部流量。语义不变的前提下，**4 个已是最少**。
> 设计与实测数据见 [`docs/plan-aggregation-and-distribution.md`](docs/plan-aggregation-and-distribution.md)。

## 为什么还要自己托管规则集

因为 MiSub 的渲染器把两件事写死了，直接引用上游 URL 一定失败：

| 环节 | MiSub 的实际行为 | 后果 |
|---|---|---|
| Clash 的 `behavior` | 只按文件名白名单判 `ipcidr`（`amazonip` / `chinacompanyip` / `chinaip` / `chinaipv6` / `netflixip`），其余一律 `classical` | 上游裸域名 payload 被当作 classical 规则解析 → 加载失败 |
| Clash 的 `format` | URL 以 `.txt`/`.list` 结尾时附加 `format: text` | 上游文件其实是 YAML（`payload:` + `- '+.x'`），按 text 解析全错 |
| sing-box 的 `format` | 仅按 `.srs` 判 `binary`，其余 `source`（要求 JSON） | 上游不提供 `.srs` 也不提供 JSON → 无可用格式 |

于是本项目把上游数据重新表达：

| 产物 | 格式 | 给谁用 |
|---|---|---|
| `dist/rules/clash/<表名>.yaml` | `payload:` + `DOMAIN-SUFFIX,x` / `DOMAIN,x` / `IP-CIDR,x` / `IP-CIDR6,x` | Clash / Mihomo（classical） |
| `dist/rules/singbox/<表名>.json` | `{"version":3,"rules":[{"domain_suffix":[…]}]}` | sing-box（source） |

域名语义严格对齐 mihomo 的 `domain_set.go`：上游 `+.x` → `DOMAIN-SUFFIX,x`，
裸 `x` → `DOMAIN,x`（精确匹配）。写错这一步会大面积失配，所以它是转换的核心逻辑。

## 与官方推荐配置的差异

刻意偏离的地方只有两处，其余完全一致：

| 项 | 官方推荐 | 本项目 | 原因 |
|---|---|---|---|
| `applications` 表 | `RULE-SET,applications,DIRECT` | **不采用** | 该表内容全是 `PROCESS-NAME`（本机进程名），在分享给他人的订阅里没有意义；且 Clash Premium 内核不支持 `PROCESS-NAME`，会导致配置加载失败 |
| `GEOIP,LAN,DIRECT` | 有 | 改用 `lancidr` 规则集 | `GEOIP,LAN` 依赖内核自带的 LAN 库，兼容性不稳；`lancidr` 是纯 CIDR 表，行为可预期 |
| 策略组命名 | `PROXY` / `REJECT` | 中文名（`🚀 节点选择` / `🛑 广告拦截` …） | 与 MiSub / ACL4SSR 生态一致 |
| `MATCH` 兜底 | `PROXY` | `🐟 漏网之鱼`（成员含 节点选择 / 自动选择 / DIRECT） | 保留用户手动改判的余地 |

另外，**sing-box 版拿不到 ini 里的兜底策略**：MiSub 的 sing-box 渲染器把
`route.final` 固定成「第一个非 DNS 策略组」（也就是 `🚀 节点选择`），
ini 里的 `FINAL` 对 sing-box 不生效。功能上等价（两者都能选到 DIRECT），
但如果你想把未命中流量改成直连，sing-box 用户要改 `🚀 节点选择` 而不是 `🐟 漏网之鱼`。

## 本地模式

### 环境要求

- Node.js 18 或更高版本（CI 与开发环境用 22）
- 零外部依赖，无需 `npm install`

### Windows 一键脚本

双击仓库根目录的 `Update-MiSub-Rules.bat`，等价于
`node scripts\loyalsoldier2misub.mjs --verify --out-dir output`。参数原样透传：

```bat
Update-MiSub-Rules.bat                         :: 三档预设全部生成到 output\
Update-MiSub-Rules.bat --preset Standard       :: 只生成标准版
Update-MiSub-Rules.bat --offline               :: 只用本地缓存，不联网
Update-MiSub-Rules.bat --dist dist             :: 生成完整产物目录
```

### 命令行

```bash
# 生成全部预设（ini）
node scripts/loyalsoldier2misub.mjs --out-dir output --all-presets --verify

# 生成完整产物（含远程规则集与聚合表）
node scripts/loyalsoldier2misub.mjs --dist dist --all-presets \
  --gh-owner <owner> --gh-repo misub-rules --gh-ref dist --verify

# 离线重跑（用 .work/loyalsoldier/ 下的缓存）
node scripts/loyalsoldier2misub.mjs --dist dist --all-presets --offline

# 可复现构建：固定上游 commit，用于一致性回归
node scripts/loyalsoldier2misub.mjs --dist /tmp/c1 --all-presets --offline \
  --upstream-commit <sha> --verify
```

### 参数

| 参数 | 说明 |
|---|---|
| `--preset Full\|Standard\|Minimal\|Agg4` | 单预设模式，默认全生成 |
| `--all-presets` | 全部预设生成 |
| `--out <file>` | 只写出一份 ini |
| `--out-dir <dir>` | ini 输出目录，默认 `output/` |
| `--dist <dir>` | 完整产物模式（规则集 + 聚合表 + ini + manifest） |
| `--gh-owner` / `--gh-repo` / `--gh-ref` | 拼接规则集的基础 URL |
| `--cdn <base>` | 覆盖 CDN 前缀，默认 `https://cdn.jsdelivr.net/gh` |
| `--verify` | 复刻 MiSub 解析 + 路由顺序模拟（`--dist` 模式下默认开启） |
| `--offline` | 只用本地缓存 |
| `--cache-dir <dir>` | 规则缓存目录，默认 `.work/loyalsoldier` |
| `--upstream-commit <sha>` | 显式固定上游 commit（`--offline` 下默认写 unknown，会破坏两次构建的一致性比对） |

首次联网拉取约 9 MB 规则数据，之后走缓存。完整构建约 17 秒。

## 验证

```bash
# 1) 内置回归：结构校验 + 路由顺序模拟 + 聚合表自检，零依赖、可离线
node scripts/loyalsoldier2misub.mjs --out-dir output --all-presets --verify

# 2) 权威口径：直接加载 MiSub 官方渲染管线
git clone --depth 1 https://github.com/imzyb/MiSub /tmp/MiSub
cd /tmp/MiSub && npm install
node <repo>/scripts/verify-with-misub.mjs --misub /tmp/MiSub \
  <repo>/output/misub-remote/Loyalsoldier_Full_MiSub_clash.ini \
  <repo>/output/misub-remote/Loyalsoldier_Agg4_MiSub_singbox.ini

# 3) 产物一致性：两次构建必须逐字节相同（仅归一化生成时间戳）
node scripts/check-consistency.mjs --left dist --right /tmp/dist2

# 4) 发布后全量链接体检（枚举 dist 全部文件 × 三通道 + 聚合版结构校验）
node scripts/check-links.mjs --owner <owner> --repo misub-rules
```

内置 `--verify` 会检查：策略组是否自洽、是否有悬空引用、是否有空组、
`[]FINAL` 是否唯一且位于末位、规则集 URL 形态、**远程规则集数量是否与预设声明一致**，
以及**每张表首/中/末三条探针能否命中自己的策略组**（用来防住顺序错乱）。
聚合表额外做三项自检：内部无重复、各源条目全包含、条目数只能变小。
任何一项不过就退出码 1，CI 会拦住不发布。

`check-consistency.mjs` 支持两种模式：

| 模式 | 判据 | 用途 |
|---|---|---|
| `full`（默认） | 逐文件相同，仅忽略生成时间戳 | 同一输入的两次构建必须完全一致 |
| `structure` | 只比 provider 数 / 策略组数 / 聚合来源 / 文件清单 | 上游数据已更新、但要确认改写逻辑没跑偏 |

MiSub 升级版本后应重跑第 2 项，因为它才是权威口径。

## 工作原理

```
GitHub Actions（每日北京时间 04:17，另有手动触发、以及 scripts/ 变更时自动重建）
  ├─ 拉取 Loyalsoldier 规则集   10 张表，约 9 MB
  ├─ 归一化                     '+.x' → 后缀匹配；裸 'x' → 精确匹配
  ├─ 生成规则集                 Clash classical YAML + sing-box source JSON
  ├─ 按策略组聚合               10 张表 → 4 张（agg-private / agg-ad / agg-proxy / agg-direct）
  ├─ 生成 ini 模板              4 档预设 × 2 内核 + 历史命名兼容副本
  ├─ 端到端校验                 解析模拟 + 路由顺序抽样 + 聚合表自检
  ├─ 一致性校验                 离线重建一次，逐文件比对（仅忽略时间戳）
  └─ 发布                      dist 分支（孤立提交 + 强制推送）
                                   ↓
                             jsDelivr CDN → MiSub → 客户端
```

**本地与 CI 一致性的保证方式**：两边调用同一个 `scripts/loyalsoldier2misub.mjs`，
CI 在发布前会用同一份缓存离线重建第二份产物，再用 `check-consistency.mjs` 逐文件比对。
任何人本地执行 README 里的两条命令，得到的结果必须与 CI 完全一致。

`dist` 分支每次以**孤立提交 + 强制推送**重建，仓库体积恒等于单次产物大小。
每日推送本身也构成仓库活动，可避免公开仓库因连续 60 天无活动被自动禁用定时任务。

## 常见问题

**多久更新一次？**

每日北京时间约 04:17，也可在 [Actions 页面](https://github.com/n2far2000/misub-rules/actions/workflows/update.yml) 手动触发。
上游 Loyalsoldier 每天北京时间 06:30 重建，所以本地取到的规则最多比上游晚一天。

**为什么规则文件这么大？**

`reject` 一张表就有 19.4 万条，`direct` 11 万条——这是 Loyalsoldier 上游的原始体量，
不是本项目生成的冗余。若嫌重，用 `Minimal` 预设（去掉 IP 表）。

**加载慢 / 内存高？**

19 万条 `DOMAIN-SUFFIX` 在 mihomo 里会构建域名 trie，桌面端无感，低配手机可能吃力。
两个降级方向：

- **改用 `Agg4`**（推荐）：规则内容与 `Full` 完全一致，但客户端启动时的并发请求从 10 个降到 4 个。
  只解决「首次拉取慢 / 弱网反复超时」，不减少条目本身。
- **改用 `Minimal`**：去掉 IP 表，条目降到 33.3 万→ 仍然很大；若要显著减少条目，
  只能换成 `[]GEOSITE` 写法（体积小得多，但数据来源就不是 Loyalsoldier 了）。

**聚合版（Agg4）和完整版有什么区别？**

规则内容相同（343,231 → 343,227 条，差的 4 条是 direct 表自身的重复项），
只是把 10 个规则集文件按策略组合并成 4 个。区别只有两点：
① 客户端并发请求少 6 个；② 失去 iCloud / 苹果 / Google / Telegram 四个独立开关
（它们的默认值本来就与目标大组相同，不动开关则分流完全一致）。

**更新后需要重新导入模板吗？**

用方式一（远程 URL）不需要。用方式二（本地粘贴）时，日常数据变化不影响结构；
只有生成器改了模板结构才需要重新粘贴。

**更新了，但客户端拿到的规则集还是旧的？**

这是缓存问题，分三层，从外到内排查：

| 层 | 缓存时长 | 能不能立刻清 |
|---|---|---|
| jsDelivr「分支 → commit」解析 | **最长 12 小时** | **不能**（purge 无效，见下） |
| jsDelivr 边缘文件缓存 | 12 小时 | 能，purge 即可 |
| 客户端本地 `ruleset/` | `interval: 86400`，24 小时 | 能，清缓存 / 删目录 |

**关键限制**：链接用的是分支引用 `@dist`。jsDelivr 会把「`dist` 当前指向哪个 commit」
按边缘节点缓存，实测同一时刻 `cdn.jsdelivr.net` 解析到前一次构建、`fastly` 解析到再前一次，
而 `raw` 已是最新；`purge.jsdelivr.net` 只清文件缓存，**推不动这一层**，
只能等它自然过期（最长 12 小时）。所以发布后最长 12 小时内，
部分地区通过 jsDelivr 拿到的仍可能是上一版 —— 这是分支引用的固有代价，
不是产物没更新（`raw.githubusercontent.com` 上永远是最新的）。

想立刻确认线上到底是什么版本：

```bash
# 权威：raw 通道，永远最新
curl -s https://raw.githubusercontent.com/n2far2000/misub-rules/dist/manifest.json | grep generatedAt
# 你实际走的 CDN 通道
curl -s https://cdn.jsdelivr.net/gh/n2far2000/misub-rules@dist/manifest.json | grep generatedAt
```

两者 `generatedAt` 不一致 → 还在 CDN 传播期，等或直接改用 raw 链接。
一致但仍看到旧规则 → 问题在客户端（清 `ruleset/` 目录后重启，或换 mihomo 内核客户端重下）。

**客户端层**：mihomo 把规则集落盘在 `ruleset/`，按 `interval: 86400` 才重新请求，
且带条件请求、内容没变就沿用本地文件。想立即生效只能清本地缓存。

**`SubBoost_*` 链接还能用吗？**

能，且长期保留。它们每天与新链接一起产出，内容完全一致。

**用 jsDelivr 下载 `.bat` 返回 403？**

jsDelivr 对所有可执行类扩展名（`.bat`/`.cmd`/`.exe`/`.ps1` 等）一律拒绝服务，
与文件内容和仓库无关。启动器本就设计为本地使用——`git clone` 后双击即可。

**Fork 后链接不可用？**

链接里的 `n2far2000/misub-rules` 是硬编码的。Fork 后需用
`--gh-owner <你的用户名> --gh-repo misub-rules` 重新生成，或直接改 ini 里的规则集 URL 前缀。

## 目录结构

```
.github/workflows/update.yml       每日自动重建工作流 + 一致性门禁
scripts/loyalsoldier2misub.mjs     生成器（零依赖）：归一化 → 规则集 → 聚合 → ini
scripts/verify-with-misub.mjs      用 MiSub 官方渲染器验证产物
scripts/check-consistency.mjs      产物一致性：两次构建逐文件比对（仅忽略时间戳）
scripts/check-links.mjs            全量链接体检：枚举两分支所有文件 × 三通道实测
Update-MiSub-Rules.bat             Windows 本地模式启动器
docs/internals.md                  源码级约束与设计依据（维护者参考）
docs/plan-aggregation-and-distribution.md  聚合方案与分发端选型（设计稿）
push.sh                            首次推送到 GitHub 的脚本
LICENSE                            AGPL-3.0 全文
NOTICE                             上游归属与许可说明
.gitignore / .gitattributes        忽略与换行符规范（.bat 保持 CRLF）
.work/loyalsoldier/                上游规则缓存（已忽略）
dist/ output/                      构建产物（已忽略，实际发布在 dist 分支）
```

## 许可与署名

本项目以 **AGPL-3.0-only** 分发，全文见 [LICENSE](LICENSE)。

规则数据派生自 Loyalsoldier/clash-rules（GPL-3.0），AGPL-3.0 与其兼容并已覆盖其要求。
完整归属见 [NOTICE](NOTICE)：

| 上游 | 许可 | 作用 |
|---|---|---|
| [Loyalsoldier/clash-rules](https://github.com/Loyalsoldier/clash-rules) | GPL-3.0 | 规则数据与白名单模式的分流顺序 |
| [imzyb/MiSub](https://github.com/imzyb/MiSub) | MIT | 目标格式规范；验证脚本调用其渲染管线 |
| [MetaCubeX/mihomo](https://github.com/MetaCubeX/mihomo) | GPL-3.0 | 仅作行为语义参考，不含其代码 |
