# 规则下发性能重构方案

> 状态：设计稿（未实施）
> 目标：在不破坏现有订阅链接的前提下，把「规则集加载」这一层的客户端开销降一到两个数量级。

---

## 1. 问题定义

### 1.1 现状量化（本仓库 dist 产物实测）

| 规则集 | 条目 | raw | gzip |
|---|---:|---:|---:|
| reject | 194,969 | 7.22 MB | 1.56 MB |
| direct | 110,516 | 3.23 MB | 0.47 MB |
| proxy | 27,245 | 0.85 MB | 0.14 MB |
| cncidr | 10,009（6,526 v4 + 3,483 v6） | 0.27 MB | 0.03 MB |
| apple / private / google / icloud / lancidr / telegramcidr | 490 | 19 KB | 4 KB |
| **合计** | **343,229** | **11.58 MB** | **2.20 MB** |

下发形态：**10 个 `type: http` 的 rule-provider，全部 `behavior: classical`**。

### 1.2 成本模型

一条规则从「上游 txt」到「客户端命中」要付四次钱，其中只有第一次和网络有关：

| # | 环节 | 成本 | 谁决定 |
|---|---|---|---|
| ① | 冷启动下载 | 10 个并发请求 × TLS 握手；gzip 合计 2.20 MB；**走直连，未经代理** | MiSub `render-clash.js:204-211`（无 `proxy` 字段） |
| ② | 解析建树 | 每次启动 + 每 24h 都要 `ParseRule` 343,229 次，构建 domain 树并保留 Payload 副本 | `behavior: classical` |
| ③ | 逐连接匹配 | 新内核走 `MultiDomain` 树；**旧内核（Clash Premium / Clash for Android / 旧 ClashX）线性扫描，最坏 343k 次比较** | 客户端内核 + `classical` |
| ④ | 周期重建 | `interval: 86400` 无条件重下 + 重解析，共 10 个文件 | MiSub `render-clash.js:209` |

关键结论：**下载只占 2.20 MB，1/4 的问题；②③ 才是「卡」的主体**，且随客户端内核新旧剧烈分化。

### 1.3 结构性问题

`behavior`、`interval`、`proxy` 三个字段**完全由 MiSub 渲染器写死**，ini 模板无法表达：

- `render-clash.js:139-151` — behavior 只按文件名白名单判 `ipcidr`（amazonip/chinacompanyip/chinaip/chinaipv6/netflixip），其余一律 `classical`
- `render-clash.js:209` — `interval: 86400`
- `render-clash.js:204-211` — 无 `proxy` 字段（mihomo 官方示例是显式 `proxy: DIRECT`）
- `template-parsers/ini-template-parser.js:71-105` — ini 只认 `<组名>,<URL>` 与 `<组名>,[]TYPE,VALUE`，没有 behavior/interval 位置

→ 所以任何「改 behavior / 改 interval / 合并减表」的方案都必须同时回答「MiSub 不改怎么办」。

---

## 2. 设计原则（来自成熟实现的共识）

| 原则 | 出处 |
|---|---|
| **能用二进制规则集就别用文本** | mihomo MRS（`docs/config.yaml:1966`）：体积与加载时间都显著优于 yaml/text |
| **能用客户端本地 geo 数据库就别下发规则集** | mihomo geodata（`geosite.dat` / `geoip.dat`，支持 `geosite-matcher: succinct`）；sing-box 官方只推荐 `.srs` remote rule_set |
| **规则条数本身就是成本** | 白名单模式的语义只需 8~10 条规则即可完整表达，343k 条是「数据」不是「规则」 |
| **匹配顺序在大表面前毫无意义** | 现状把 194,969 条 reject 放在最前，旧内核每条连接先扫 19 万条才轮到直连判断 |
| **不要让用户为别人的 TUN 环境买单** | 参考 MiSub 关 IPv6 的取舍——反过来说，规则精度/性能也不该用「一套打天下」解决 |

---

## 3. 候选方案矩阵

| 编号 | 方案 | 成熟参考 | 条目数 | 下载 | MiSub 可行性 | 精度 | 工作量 |
|---|---|---|---:|---|---|---|---|
| **A** | **geo 内联**（`GEOSITE` / `GEOIP`，几乎零 provider） | v2fly geosite、sing-geosite、mihomo geodata | **18**（仅遗留 lancidr） | Clash 638 B；sing-box ≈287 KB | ✅ **双向原生支持**，零改动 | 中 | 小 |
| B | 自建表改 `behavior: domain` + 合并 | blackmatrix7/ios_rule_script | 343k | 2.15 MB | ❌ 需改 MiSub 渲染器 | 高 | 中 |
| C | 自建 MRS 二进制规则集 | meta-rules-dat、mihomo MRS | 343k | ~0.5 MB | ❌ MRS 仅支持 domain/ipcidr，MiSub 只给 classical | 高 | 中 |
| D | 原生订阅，绕过 MiSub | 自建完整 Clash 配置 | 自定 | 自定 | ✅ 不依赖 MiSub | 最高 | 大 |
| E | 合并 10→4（保持 classical） | — | 343k | 2.20 MB | ✅ | 高 | 小 |

**判据**：E 实测对下载零改善（2.20 → 2.20 MB），只省 6 次握手，不作为主线；
A 是唯一「不改 MiSub、立刻见效」的路线；B/C/D 属于精度优先的进阶路线。

---

## 4. 推荐方案：A 为默认，B/D 为进阶

### 4.1 P0 — Geo 预设（provider 10 → 1，MiSub 零改动）

新增一个预设 `Geo`，ini 里**不出现任何 `ruleset=<组名>,<URL>`**，全部用内联规则：

```ini
[custom]

# ---- 🛑 广告拦截 ----
ruleset=🛑 广告拦截,[]GEOSITE,category-ads-all

# ---- 🏠 私有网络 ----
ruleset=🏠 私有网络,[]GEOSITE,private
# 私有 IP 段不能内联，见下方「为什么保留 1 个 provider」
ruleset=🏠 私有网络,https://cdn.jsdelivr.net/gh/<owner>/<repo>@dist/rules/clash/lancidr.yaml

# ---- 苹果 / iCloud / Google（大陆可直连部分）----
ruleset=☁️ iCloud,[]GEOSITE,icloud
ruleset=🍎 苹果服务,[]GEOSITE,apple
ruleset=🔍 Google,[]GEOSITE,google

# ---- 代理 / 直连 ----
ruleset=📲 Telegram,[]GEOSITE,telegram
ruleset=🚀 节点选择,[]GEOSITE,geolocation-!cn
ruleset=🎯 全球直连,[]GEOSITE,cn
ruleset=🎯 全球直连,[]GEOIP,CN

ruleset=🐟 漏网之鱼,[]FINAL
```

**为什么保留 1 个 provider（`lancidr`，638 B / 18 条）而不是全部内联？**

`render-clash.js:153-163` 的 `mapRule()` 对非 `MATCH/GEOIP/RULE-SET` 的类型只输出
`${type},${value},${policy}`，**`extras` 被丢弃** —— 也就是 `[]IP-CIDR,10.0.0.0/8,no-resolve`
里的 `no-resolve` 会静默消失；同时 `render-singbox.js:292-332` 的 `mapRuleToSingbox()`
对内联 `IP-CIDR` 直接 `return null`（该规则在 sing-box 通道会被整条丢掉）。
两条都是静默失败，所以私有 IP 段继续走一个 638 B 的单表 provider，代价可忽略。

**两条通道的行为**（均已在 MiSub 源码确认）：

| 通道 | 渲染结果 | 客户端成本 |
|---|---|---|
| Clash / Mihomo | 原生 `GEOSITE,category-ads-all,🛑 广告拦截` 规则（`render-clash.js:153-163` 的 `mapRule`） | 0 下载（用客户端本地 `geosite.dat`/`geoip.dat`，mihomo 自动维护），匹配走 succinct trie |
| sing-box | 自动生成 `type: remote` / `format: binary` 的 `.srs` 规则集（`render-singbox.js:357-384`），URL 指向 `SagerNet/sing-geosite` 与 `sing-geoip` 的 `rule-set` 分支 | 实测体积合计 **287 KB**（ads 8,121 / cn 56,189 / geolocation-!cn 168,426 / apple 17,230 / google 7,752 / private 788 / icloud 548 / telegram 265 / geoip-cn 34,268），24h 更新且 `download_detour` 走代理 |

**收益**：provider 10 → 1；规则条目 343,229 → 18（仅遗留的 `lancidr`）；
下载 2.20 MB → 638 B（Clash）/ 287 KB（sing-box）；
旧内核不再线性扫描（geosite 也是 trie 匹配）；④ 周期重建从 10 个文件降到 1 个。

**代价与风险**：
1. **精度下降**。v2fly `category-ads-all` 的覆盖窄于 Loyalsoldier 的 AdGuard 汇总（194,969 条）；
   `geosite:cn` 的域名覆盖也小于 `direct.txt`（110,516 条）。这是必须明示的取舍，不能悄悄替换。
2. 依赖客户端 geo 数据更新。mihomo 自动下载并共享；**Clash Premium 需用户自备 `GeoSite.dat` + `Country.mmdb`**，
   缺失时这些规则会静默失效（不报错）。
3. `GEOSITE,name@attr`（如 `apple@cn`）可进一步收窄到「大陆可直连子集」，但 mihomo 侧未实测，暂不写进预设。
4. 若客户端是 sing-box 且离线，`.srs` 仍需联网首次拉取（但由 `download_detour` 走代理，且总量 287 KB）。

### 4.2 P1 — 精度优先：自建表改 domain behavior（需 MiSub 支持）

只有在 P0 的精度不够时才做。做法与阻塞点：

1. 把 6 张域名表输出成**裸域名**（`+.example.com`），3 张 IP 表输出成 `1.2.3.0/24` 并独立成 `ipcidr` provider
2. 需要 MiSub 的 `getRuleProviderBehavior()` 支持从 URL query 读 behavior（`?behavior=domain`），
   这是最小改动（ini 语法完全不用动）
3. 实测收益有限但方向正确：raw 11.58 → 7.79 MB，**gzip 2.20 → 2.15 MB（几乎不变）**；
   真正的收益在解析与内存，以及旧内核也不再线性扫描
4. **不能原地替换**：未升级的 MiSub 会把裸域名当 classical 喂给 mihomo，`unsupported rule` → 整份配置加载失败。
   必须新开 `rules-domain/` + `misub-domain/` 一套 URL

### 4.3 P2 — 终极形态：原生订阅（绕过 MiSub）

自建完整 Clash 配置：`proxy-providers` 承接机场订阅 + MRS 规则集 + `geodata-loader: mmap` +
自定义 `interval` / `proxy`。自由度最高，但等于自建一个订阅服务，维护成本最大，仅在未来需要
「按用户定制分流」时才考虑。

---

## 5. 迁移策略

| 步骤 | 动作 | 兼容性 |
|---|---|---|
| 1 | 新增 `misub/Geo_Full_MiSub.ini` 等 3 个 Geo 预设（**不改任何现有文件名**） | 现有 9+3 个历史链接逐字节不变 |
| 2 | README 加「性能档位」对照表，把 Geo 标为「低配设备 / 旧内核推荐」 | — |
| 3 | 观察 2 个发布周期；确认 geosite 精度可接受后，再讨论是否把主链接切到 Geo | 主链接切换是一次性、可回滚（孤立提交重建） |
| 4 | 视 MiSub 上游进展决定是否启动 P1 | — |

原则：**新增不替换**。用户手里已有链接的语义不因性能优化而变。

---

## 6. 验收标准

| 指标 | 现状 | P0 目标 | 测量方法 |
|---|---|---|---|
| rule-provider 数量 | 10 | **1**（仅 lancidr，638 B） | 渲染成品 `rule-providers` 键数量 |
| 内联规则条数 | 14 | ≤ 20 | 渲染成品 `rules` 数组长度 |
| Clash 侧规则集下载 | 2.20 MB(gz) | **638 B** | 抓包 / 客户端日志 |
| sing-box 侧规则集下载 | 6.7 MB | ≤ 300 KB | `.srs` 文件 Content-Length 求和 |
| 冷启动到规则就绪 | 未测 | ≤ 1 s | mihomo 日志时间戳差 |
| 常驻内存增量 | 未测 | ≤ 15 MB | RSS 对比空配置 |
| 旧内核（Premium/CFA）匹配 | 线性 ≤343k | trie | 用 Premium 内核实测连接建立延迟 |
| 配置合法性 | ✅ | ✅ | `mihomo -t -f config.yaml`，以及 MiSub 渲染管线 18/18 |

补充：现有 `scripts/check-links.mjs` 需要新增两条断言 ——「Geo 预设产物的 `rule-providers` 仅含 `lancidr`」、
「`ruleset=<组名>,http` 行数 ≤ 1」，避免回退。

---

## 7. 实施清单（P0）

- [ ] `scripts/loyalsoldier2misub.mjs`：`PRESETS` 增加 `Geo`，`ruleLinesForPreset()` 支持纯内联输出
- [ ] 生成器新增 `--only geo` / `--all-presets` 覆盖新预设，产物沿用现有目录结构
- [ ] `check-links.mjs` 增加上述两条断言
- [ ] `verify-with-misub.mjs` 对 Geo 预设跑一遍官方渲染管线（18 文件基线扩展到 24）
- [ ] 本地 `mihomo -t` 校验渲染成品 + 实测冷启动耗时与 RSS
- [ ] README / NOTICE 增加精度取舍说明（禁止出现「等价替换」表述）
- [ ] 发布 dist，保持所有既有文件 md5 不变

---

## 8. 参考

- mihomo 配置文档：MRS 规则集仅支持 `domain` / `ipcidr`（`docs/config.yaml:1966-1983`）、`geosite-matcher`（`:42`）、`geodata-loader` 默认 `memconservative`（`config/config.go:493`）
- MiSub：`template-renderers/render-clash.js`、`template-renderers/render-singbox.js:342-387`、`template-parsers/ini-template-parser.js`、`subscription/safe-dns.js`
- 规则来源：`v2fly/domain-list-community`（`data/` 共 1,547 个分类）、`SagerNet/sing-geosite` + `sing-geoip`（`rule-set` 分支 `.srs`）、`MetaCubeX/meta-rules-dat`
- 现状取舍记录：`docs/internals.md`、`.workbuddy/memory` 中 2026-10-18 的性能归因与实测
