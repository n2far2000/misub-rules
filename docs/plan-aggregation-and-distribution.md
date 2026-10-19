# 两条路线计划稿：构建侧聚合（单文件）+ 分发端选型

> 状态：**Agg-4 已实施（2026-10-19）**；思路二的选型仍为待办（内存数字未实测）。
>
> 实施时相对本稿的一处改进：私有网络不再采用「域名内联 + lancidr 独立」，
> 而是新增第 4 张聚合表 `agg-private` = private + lancidr（域名与 IP 混合）。
> 这样**零内联**、私有组语义完整、文件数正好 4，且避免了 sing-box 内联 `IP-CIDR`
> 被 MiSub 丢弃的问题（见 `performance-redesign.md` §4.2）。
>
> 实测（commit `4006d22`）：Full 343,231 条 / Agg4 343,227 条，差的 4 条是 direct 表自身重复项；
> 4 张聚合表 = `agg-private` 150 / `agg-ad` 194,969 / `agg-proxy` 27,257 / `agg-direct` 120,851。
> 数据基准：`dist` @ `2026-10-18` 产物，上游 `Loyalsoldier/clash-rules@release` `6e1dd2b`。
> 前置文档：`docs/performance-redesign.md`（Geo 内联方案）、`docs/internals.md`（MiSub 格式约束）。

---

## 0. 决策摘要

| 问题 | 结论 |
|---|---|
| 单文件能不能做到「语义不变」？ | **不能**。一个规则集文件只能绑定一个策略组。语义不变前提下，文件数**下界是 3** |
| 那「1 个文件」怎么做？ | 只剩广告表 + 其余交给 `GEOIP,CN` 与 `FINAL`，或改用 `GEOSITE` 内联 → **精度明显下降** |
| 合并能省多少流量？ | **几乎为零**（gzip 2.20 MB → 2.20 MB）。省的是 **7 次请求 / TLS 握手 / 并发** |
| 思路一值不值得做？ | 值得，但定位要改：它是「**弱网首屏优化**」，不是「省流量」 |
| 低内存分发端有成熟选择吗？ | 有。**subconverter**（C++，镜像 7.4 MB）最省；**Sub-Store**（Node，功能最全）次之。B 类节点面板不适合承担规则分发 |

---

# 思路一：构建侧自动聚合 → 减少并发

## 1.1 先把「单文件」拆成三个不同的诉求

用户说的「减少并发」在工程上是三件独立的事，只有第一件能靠合并解决：

| 诉求 | 现状成本 | 合并能否解决 |
|---|---|---|
| **请求数 / 并发数** | 10 个 rule-provider 并发拉取 | ✅ 主目标 |
| **传输字节** | gzip 合计 2.20 MB | ❌ 合并后仍 2.20 MB（`DOMAIN-SUFFIX,` 前缀高度重复，压缩率不随文件数变化） |
| **解析条目数** | 343,180 条 classical | ❌ 合并不改条目数，只改文件边界 |

所以这个方案的收益口径必须写成「**弱网首屏更快、握手更少、失败面更小**」，不能承诺省流量。

## 1.2 硬约束：一个规则集文件只能绑定一个策略组

这不是 MiSub 的限制，是 mihomo / sing-box 的模型决定的：

- `rule-providers` 的 `behavior: classical`，payload 里每行只是 `TYPE,VALUE`（如 `DOMAIN-SUFFIX,x`），**不带 policy**；policy 由引用它的 `RULE-SET,<name>,<policy>` 决定。
- 因此「一个文件喂给 4 个策略组」在语法上可行，但语义上灾难：同一份集合被 4 条规则依次引用，**全部流量会被第一条规则吃掉**。
- sing-box 侧同理：`rule_set` 是纯集合，`route.rules` 里多条规则引用同一集合，第一条命中即终止。

**结论：文件数 ≥ 实际使用的策略组数。** 想再往下压，只能减少策略组，或让规则改由客户端本地数据库承担（Geo）。

## 1.3 阶梯与实测数据

用当前产物离线模拟（按组拼接、组内去重、保持原顺序）：

| 档 | 文件 | 请求 | 条目 | raw | gzip | 保留的策略组 | 语义 |
|---|---|---|---|---|---|---|---|
| **现状** | 10 | 10 | 343,180 | 11.58 MB | **2.20 MB** | 10 个细分组 | 基准 |
| **Agg-3** | 3 | **3** | 342,775 | 11.57 MB | **2.20 MB** | 广告 / 直连（含 apple·icloud·google·cncidr·lancidr）/ 代理（含 telegramcidr） | ✅ **等价**（顺序不变，私有域名改内联） |
| Agg-2 | 2 | 2 | 315,519 | 10.72 MB | 2.06 MB | 广告 / 直连 | ⚠️ **158 条失真**（见下） |
| Agg-1 | 1 | 1 | 194,969 | 7.22 MB | 1.56 MB | 广告 | ❌ 直连表 12 万条全丢，只剩 `GEOIP,CN` |

### 为什么 Agg-2 会失真（实测）

`proxy.yaml` 与 `direct.yaml` 有 **158 条域名交集**（样例：`265.com`、`2mdn.net`、`admob-cn.com`、`alibabacloud.com`、`agefans.com`）。现状顺序里 proxy 在 direct 之前，这 158 条**走代理**；删掉 proxy 表后落进 direct → **改走直连**。

这 158 条恰好都是「在中国有 CDN 的境外服务」，是最不该靠猜的一批。**所以 Agg-2 / Agg-1 不作为主推档，只在需要极致精简时提供，并在 README 明示差异。**

### 为什么 Agg-3 是语义等价的下界

1. 三条 provider 的先后顺序 = 现 ini 里 ruleset 行的先后顺序（广告 → 直连 → 代理），客户端按 `rules` 数组顺序匹配，命中行为不变。
2. 私有网络域名表只有 **130 条**、私有 IP 表 **18 条** —— 改为 ini 内联（`[]DOMAIN-SUFFIX,x` / `[]IP-CIDR,x`），**零请求**，条目数不变。
   ⚠️ 已知限制：MiSub 的 `mapRule()` 会丢弃 extras，内联 `[]IP-CIDR` 的 `no-resolve` 会消失；sing-box 通道对内联 `IP-CIDR` 直接返回 `null`（详见 `performance-redesign.md` §4.2）。所以私有 IP 那 18 条要么接受 sing-box 侧缺失，要么继续用 638 B 的 `lancidr.yaml`（→ 变 4 文件）。
3. 组内去重只抽掉同一组内重复的条目（实测抽掉 405 条），**跨组不去重**。

> **推荐档：Agg-3（3 文件）**，若不能接受 sing-box 侧私有 IP 缺失，则 Agg-4（4 文件，保留 `lancidr`）。

## 1.4 构建侧怎么做（增量改造，不动现有产物）

数据流：

```
上游 release/*.txt
   └─ normalizeSet()            ← 现有，不变
        └─ rules/clash/{10 张}.yaml   ← 现有，逐字节不变（历史链接继续指向这里）
             └─ 【新增】aggregate()   ← 按策略组拼接 + 组内去重 + 保序
                  ├─ rules/clash/agg/{ad,direct,proxy}.yaml
                  └─ rules/singbox/agg/{ad,direct,proxy}.json
                       └─ 【新增】PRESETS.Agg3
                            └─ misub-remote/Agg3_{clash,singbox}.ini
```

四个改动点（都在 `scripts/loyalsoldier2misub.mjs`）：

| # | 位置 | 改动 |
|---|---|---|
| 1 | `SOURCES` 之后 | 新增 `AGGREGATES` 常量：`ad=[reject]`、`direct=[direct,apple,icloud,google,cncidr,lancidr]`、`proxy=[proxy,telegramcidr]`，并标注 `order` 以锁定拼接顺序 |
| 2 | `normalizeSet` 之后 | 新增 `buildAggregates()`：读已生成的内存集合 → 按 `AGGREGATES` 拼接 → 组内按「规则主体（域名/网段）」去重、**保留首次出现顺序** → 复用现有 `renderClashYaml()` / `renderSingboxJson()` 输出到 `rules/*/agg/` |
| 3 | `PRESETS` | 新增 `Agg3` / `Agg2` / `Agg1` 三档；`rules` 里 3 条 `<组>,<agg URL>` + 私有内联 + `GEOIP,CN` + `FINAL` |
| 4 | `verifyIni()` | 新增断言：`ruleset=<http>` 行数 == 期望文件数；合并后条目数 == Σ(源条目) − 组内重复数；`[]FINAL` 唯一且在末位 |

`aggregate` 必须是**纯内存二次加工**：先按现有逻辑把 10 张表算出来，再在内存里合并，**不重新下载、不重新解析上游**。这样上游抓取失败时的行为与现在完全一致，也不会让 workflow 时长增加（预计 +0.2 s）。

## 1.5 产物与链接策略

**原则：一个历史链接都不动。**

| 类别 | 路径 | 处置 |
|---|---|---|
| 历史 9 条 | `misub/SubBoost_*`、`misub-remote/SubBoost_*` | 不动 |
| 当前主链接 | `misub/Loyalsoldier_*`、`misub-remote/Loyalsoldier_*` | 不动 |
| **新增** | `misub/Agg3_MiSub.ini`、`misub-remote/Agg3_MiSub_{clash,singbox}.ini` | 新增，README 里作为「弱网/老设备推荐」标注 |

不新增 `Agg2` / `Agg1` 的文件，除非明确要「极致精简」标签 —— 每多一档就多一份维护与验证成本。**先只发 Agg-3（或 Agg-4）。**

## 1.6 验证计划（三层，缺一不可）

| 层 | 手段 | 通过标准 |
|---|---|---|
| L1 静态 | `node scripts/loyalsoldier2misub.mjs --dist dist --all-presets --verify` | 断言全过；10 张原表 md5 与改造前逐一相等（证明没动旧产物） |
| L2 渲染 | clone MiSub → 用 `verify-with-misub.mjs` 跑官方渲染管线 | Agg3 渲染成品：`rules` 数组长度 = 3 + 内联数 + 1(FINAL)；3 个 provider `behavior=classical`、`format=yaml`；末条 `MATCH,🐟 漏网之鱼` |
| L3 端到端 | 本地 mihomo `-t`（配置校验）+ 三通道实测 `check-links.mjs` | 配置加载 0 error；Agg3 三个 URL 三通道均 200 且 md5 一致 |

**回归红线**：L1 必须证明「10 张原表的 md5 与改造前完全一致」，否则说明 aggregate 阶段污染了旧路径。

## 1.7 风险与代价

| 风险 | 说明 | 缓解 |
|---|---|---|
| 首次切换缓存全失效 | provider 名与 path 变（`ad.yaml` 之类），旧 ruleset 缓存作废，需重下 2.2 MB 一次 | 只影响新链接使用者一次；README 说明 |
| 单文件更大 → 单连接风险 | 7.2 MB 的 `ad.yaml` 若断流重试，代价比 2.2 MB 的 3 个小文件高 | 走 jsDelivr（支持 h2 + gzip），实测 gzip 后 1.56 MB，可接受 |
| 失去细分开关 | 无法单独把 Google 切代理 / 把 iCloud 切代理 | 保留现有 10 表链接不受影响；Agg 档在 README 标注「细分能力已取舍」 |
| 私有 IP 内联在 sing-box 失效 | MiSub 返回 null | 选 Agg-4（保留 `lancidr`）即可规避，代价 +1 文件 |
| 条目数断言难写 | 组内去重数依赖上游内容 | 断言写成「合并后条目 ∈ [Σ − 1000, Σ]」或改断言「合并后条目集合 == 各源集合的并集」 |

## 1.8 分期

| 期 | 内容 | 产出 |
|---|---|---|
| P0 | 实现 `aggregate()` + `Agg3` 预设 + 4 条断言；本地跑 L1/L2/L3 | 3 个新 ini + 3 个 agg yaml，历史链接零变化 |
| P1 | 发布 dist、README 增加「档位对照表」（现状 / Agg3 / Geo） | 线上可访问 |
| P2 | 观察一周真实反馈，决定是否把 Agg3 提为主推 | — |
| P3（可选） | 与 Geo 方案组合：`ad` 换成 `GEOSITE,category-ads-all` → 2 文件、下载降到 0.51 MB | 需接受广告拦截精度下降 |

## 1.9 一句话取舍

**思路一买到的是「并发数 10→3」，代价是「策略组细分能力 + 一次缓存重建」。它不会省流量，也不会让旧内核变快。** 如果用户抱怨的是「用起来卡」，这个方案无效 —— 那要靠 Geo 内联或 `behavior: domain`。

---

# 思路二：低内存占用、带管理面板的订阅分发项目

## 2.1 先分类，避免选错方向

「订阅分发」在中文语境里混指三类完全不同的东西：

| 类 | 职责 | 代表 | 是否适合我们 |
|---|---|---|---|
| **A 类 · 订阅转换 / 规则分发** | 吃订阅源 + 规则模板 → 吐客户端配置 | subconverter、Sub-Store、MiSub | ✅ **这才是我们要的** |
| B 类 · 节点面板 | 管理入站/用户/流量，顺带吐订阅 | 3x-ui、s-ui、Marzban、Hiddify、Remnawave | ❌ 规则能力普遍很弱 |
| C 类 · 规则集生产 | 产出规则数据本身 | 本项目、Loyalsoldier、Custom_OpenClash_Rules | 不是分发端 |

B 类项目的「订阅」是**节点清单**，几乎没有规则模板引擎；用它们承载白名单规则等于自己写脚本。**所以下面只在 A 类里选。**

## 2.2 A 类候选实测数据

| 项目 | 语言 | ★ | 最近提交 | Docker 镜像 | 形态 | 面板 |
|---|---|---|---|---|---|---|
| **subconverter** | C++ | 17.1k | 2026-07-09 | **7.4 MB** | 单二进制 + HTTP API | 弱（需配 sub-web） |
| **Sub-Store** | JS (Node) | 10.7k | 2026-10-19 | 69.3 MB | Node 后端 + PWA 前端 | **强**（完整 Web UI） |
| MiSub（现用） | JS (Node) | 2.6k | 2026-10-14 | 无官方镜像 | Node | 中 |
| sub-web | JS (Vue) | 6.5k | 2026-10-06 | 静态前端 | 只做 UI | 前端 |

镜像体积来自 Docker Hub API 实测（`full_size`）。**常驻内存为量级估算，尚未实测** —— 见 §2.5 的实验设计。

| 项目 | 常驻内存（估算） | 依据 |
|---|---|---|
| subconverter | **30–80 MB** | C++ 静态链接、无运行时 GC；规则集全量驻留 + 每组一份 regex 缓存 |
| Sub-Store | 100–200 MB | Node 运行时基线 ~50 MB + V8 堆；大订阅处理有峰值 |
| MiSub | 80–150 MB | 同上，且带 SQLite |

## 2.3 逐项评估（对我们这套需求）

### subconverter —— 内存最优解

**能做什么**
- `ruleset=` 多条 → 输出 Clash 时生成 `rule-providers`；支持 `target=clash / singbox / surge / v2ray` 等（`src/generator/config/subexport.cpp` 有 `SingBox` 分支）
- 规则集支持本地缓存（`/getruleset` 端点），远程表可预拉后本地托管
- `max-allowed-rulesets` 可硬性限制 provider 数量 —— **正好能强制落实思路一的「少文件」约束**

**缺什么**
- 规则语义写死在 C++ 里，改行为要重编译；配置靠 `pref.ini`，面板只能改参数
- 官方面板几乎不存在，需要自己接 `sub-web`（另一个仓库，只提供表单 UI）
- **项目节奏慢**：最近提交 2026-07-09，比 Sub-Store 慢 3 个月；issue 响应不可预期
- 同样受「一文件一策略组」约束，不能替我们做语义合并

**适合**：只做「模板 + 规则 → 订阅」这一件事，跑在 512 MB 的机器上，能接受用 `pref.ini` 管配置。

### Sub-Store —— 功能最全，内存次优

**能做什么**
- 完整 Web 管理面板（节点、订阅组、脚本过滤器、文件托管），PWA 可装到手机
- 「订阅组」可以把多个订阅合成一个 URL —— 这是 MiSub 的同类能力
- **File 托管**：可以把任意文本（包括规则集）托管成 URL，**天然能当我们的规则集镜像**
- 支持脚本过滤器/操作器，能在下发时动态改配置（例如**强制写 `ipv6: true`，绕开 MiSub 那个硬编码**）
- mihomo 节点类型覆盖最全（含 AnyTLS / Hysteria2 / TUIC / MASQUE）

**缺什么**
- 规则模板能力弱于 MiSub：它面向「节点订阅」，不是「规则模板引擎」；要产出我们这种 14 行 `ruleset` 的结构，得靠脚本或多层组合
- 内存比 C++ 高一个量级
- 前端与后端都在同一个 Node 进程体系内，机器低于 512 MB 会吃紧

**适合**：想要一个真正的面板、并且愿意把「规则拼装」写成脚本；同时能顺手解决 ipv6 硬编码问题。

### MiSub 自建 —— 保持现状的第三条路

- 优势：现有 ini 资产、历史链接、渲染行为都已验证；规则模板语法最贴合我们
- 劣势：Node 内存不占优；`ipv6: false`、`behavior` 白名单等硬编码要自己打补丁
- **打补丁的收益**：仅需 2 处改动就能把 IPv6 与 `behavior: domain` 放开（`render-clash.js:218`、`safe-dns.js:261`），这比换项目便宜得多

## 2.4 推荐组合

| 场景 | 推荐 | 理由 |
|---|---|---|
| **只想少占内存、能接受手改 ini** | **subconverter + sub-web** | 镜像 7.4 MB，512 MB 机器绰绰有余；规则能力够用 |
| **想要面板、愿意写点脚本、顺手解决 ipv6** | **Sub-Store** | 功能最全，File 托管可直接承载我们的规则集 |
| **不想迁移、只想修掉硬编码** | **自建 MiSub + 2 行补丁** | 迁移成本最低，风险最小 |
| 需要节点管理 | 另上 3x-ui / s-ui（Go，单二进制），但**不要让它们承担规则分发** | 职责分离 |

**我的判断**：当前痛点里「规则集导致客户端卡顿」与分发端无关（那是客户端解析/匹配问题），换分发端**不会**改善客户端卡顿。换分发端真正能解决的是：内存占用、ipv6 硬编码、behavior 白名单、面板体验。这两件事要分开立项，别期待一次迁移同时解决。

## 2.5 待实测清单（P0 实验设计，尚未执行）

目标：把上表的「估算内存」换成实测数字。步骤如下，任意 Linux 机器（有 Docker）可跑：

```bash
# 1) 拉起候选（只做 idle 基线，不接真实流量）
docker run -d --name sc  -p 25500:25500 tindy2013/subconverter:latest
docker run -d --name ss  -p 3001:3001  xream/sub-store:latest

# 2) idle RSS（稳定 30s 后采样，取 3 次）
for c in sc ss; do
  echo "== $c =="
  for i in 1 2 3; do docker stats --no-stream --format '{{.MemUsage}}' $c; sleep 10; done
done

# 3) 加载大规则集后的 RSS（关键一步：34 万条）
#    subconverter：把 3 个 agg yaml 放进 rules/，配 ruleset= 后调一次 /sub
#    Sub-Store：作为 File 托管后拉一次完整订阅
docker stats --no-stream --format '{{.Name}}\t{{.MemUsage}}\t{{.CPUPerc}}' sc ss

# 4) 单次请求耗时（冷 / 热各 5 次）
for i in 1 2 3 4 5; do curl -s -o /dev/null -w '%{time_total}\n' 'http://127.0.0.1:25500/sub?...'; done
```

判据（三选一通过即入围）：
1. 加载 34 万条规则后 RSS < **200 MB**
2. 冷渲染一次 < **3 s**
3. 镜像 < 100 MB

## 2.6 一个容易忽略的点

无论选哪个分发端，**客户端侧的卡顿决策权都不在服务端**。真正的杠杆仍是：

| 杠杆 | 在谁手里 |
|---|---|
| `behavior: classical` → `domain` | 分发端渲染器（MiSub 硬编码 / subconverter 可配） |
| 规则条目数从 34 万降到 ~18 | 规则集生产端（本项目，走 Geo 方案） |
| `proxy` 字段 / 下载是否走代理 | 分发端模板 |
| 内核版本（trie vs 线性扫描） | 用户的客户端 |

**subconverter 与 Sub-Store 都不会自动帮我们解决前两项**，它们只是换个地方承载同样的数据。

---

# 需要你拍板的三个决策点

1. **思路一做到哪一档**：Agg-3（3 文件，语义等价 + 内联私有域名）还是 Agg-4（4 文件，多留一个 `lancidr` provider 保证 sing-box 侧私有 IP 有效）？我倾向 **Agg-4** —— 多 1 个 638 B 的请求，换来 sing-box 通道不出错。
2. **要不要同时发 Agg-2 / Agg-1**（有语义损失，但文件数更少）？我倾向 **不发**，避免维护多套语义。
3. **思路二先做实测还是先做结论**：要不要我先跑 §2.5 的实验把内存数字钉死，再决定是否迁移？这需要一台能跑 Docker 的机器。

# 明确不做

- 不把规则内联进最终客户端配置（12 MB 配置，每次订阅刷新重下整包，比现在更糟）
- 不为了「单文件」牺牲广告拦截 / TTL 精度（拒绝把 `reject` 换成 `geosite:category-ads-all`）
- 不在 B 类节点面板上硬塞规则分发
- 不原地替换任何现有链接
