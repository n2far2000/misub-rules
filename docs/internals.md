# 设计依据与内部约束

本文档面向维护者，记录生成器的设计依据，以及 **MiSub、mihomo、Loyalsoldier 三方的源码级事实**，
以及修改产物格式前必须遵守的约束。

文中结论均来自实际读取上游源码 / 实际下载上游数据，而非文档描述或经验推断。

| 上游 | 版本 / 引用 | 核对日期 |
|---|---|---|
| [imzyb/MiSub](https://github.com/imzyb/MiSub) | `main` @ `4952c16`（2026-10-14） | 2026-10-18 |
| [MetaCubeX/mihomo](https://github.com/MetaCubeX/mihomo) | `Alpha` 分支 `rules/provider/*`、`component/trie/*` | 2026-10-18 |
| [Loyalsoldier/clash-rules](https://github.com/Loyalsoldier/clash-rules) | `release` 分支 | 2026-10-18 |

> 上游若调整实现，以下结论可能失效。修改产物格式前请先按[第 6 节](#6-验证方法)重新验证。

---

## 1. MiSub 侧约束（消费端）

### 1.1 ini 解析：`ruleset=` 与 `custom_proxy_group=` 都必须在 `[custom]` 段内

`functions/modules/subscription/template-parsers/ini-template-parser.js`：

```js
const aclCustomLines = sections.get('custom') || [];
const parsedAclGroups = aclCustomLines.filter(l => /^custom_proxy_group=/i.test(l)) ...
const parsedAclRules  = aclCustomLines.filter(l => /^ruleset=/i.test(l)) ...
```

**关键点：不要把策略组写进 `[proxy group]` 段。** 那个段用的是另一套语法
（`组名=类型,成员1,成员2`，由 `parseGroupLine` 处理），ACL4SSR 的反引号语义
（``custom_proxy_group=名称`类型`[]成员``）在那里会被完全误解析。

`ruleset=` 行的两种形态：

| 写法 | 生成 | 说明 |
|---|---|---|
| `ruleset=<组名>,<http URL>` | rule-provider / rule_set | 远程规则集 |
| `ruleset=<组名>,[]TYPE,VALUE` | 内联原生规则 | 如 `[]GEOIP,CN`、`[]DOMAIN,a.com` |
| `ruleset=<组名>,[]FINAL` | Clash 的 `MATCH,组名` | sing-box 下不生效，见 1.3 |

另外 `parseAclRuleSetLine` 会剥掉 `clash-classic:` / `surge:` / `quanx:` 等格式前缀，
并按第一个逗号切分 policy 与 source —— 所以 **URL 里不能出现逗号**。

### 1.2 远程规则集的 `behavior` 与 `format`：靠文件名猜，且猜法是硬的

`functions/modules/subscription/template-renderers/render-clash.js`：

```js
const ACL4SSR_IPCIDR_PROVIDER_FILES = new Set([
    'amazonip', 'chinacompanyip', 'chinaip', 'chinaipv6', 'netflixip',
]);

function getRuleProviderBehavior(providerUrl) {
    const fileName = new URL(providerUrl).pathname.split('/').pop()
        ?.replace(/\.(yaml|yml|list|txt|conf)$/i, '') || '';
    if (ACL4SSR_IPCIDR_PROVIDER_FILES.has(fileName.toLowerCase())) return 'ipcidr';
    return 'classical';   // 其余一律 classical，没有第三条路
}
```

provider 定义处：

```js
const usesTextList = /\.(list|txt)$/i.test(providerUrl);
ruleProviders[providerName] = {
    type: 'http',
    behavior: getRuleProviderBehavior(providerUrl),
    url: providerUrl,
    path: `./ruleset/${providerName}.${usesTextList ? 'list' : 'yaml'}`,
    interval: 86400,
    ...(usesTextList ? { format: 'text' } : {}),
};
```

由此得出三条硬约束：

1. **`behavior` 无法为 `domain`。** 白名单里只有 ipcidr 相关名字，其余全是 `classical`。
   所以域名规则集必须是**完整规则语法**（`DOMAIN-SUFFIX,x`），不能是裸域名。
2. **URL 用 `.yaml` 结尾**，避免被追加 `format: text`。上游文件其实是 YAML
   （`payload:` + `- '+.x'`），按 text 解析会全错。
3. 不要试图用 `chinaip.yaml` 这类文件名去骗 `ipcidr`。虽然能生效，但它依赖一个
   只有 5 个元素的私有白名单，上游随时可能改。本项目 IP 表统一走 classical，
   用 `IP-CIDR,` / `IP-CIDR6,` 前缀表达，语义等价、更稳。

> 一个相关的坑：`toClashRuleProviderUrl()` 会重写 URL，但只针对 `ACL4SSR/ACL4SSR`
> 仓库（把 `/Clash/*.list` 改成 `/Clash/Providers/Ruleset/*.yaml`）。
> 其他仓库（包括我们自己和 Loyalsoldier）原样返回，所以自托管 URL 是安全的。

### 1.3 sing-box 渲染器：只认 `.srs` 或 JSON，兜底策略写死

`functions/modules/subscription/template-renderers/render-singbox.js`：

```js
function detectRuleSetFormat(url) {
    return String(url).toLowerCase().endsWith('.srs') ? 'binary' : 'source';
}
// route:
final: normalizedModel.groups.find(g => g.name !== DNS_PROXY_GROUP)?.name || 'DIRECT',
```

- `format` 只看扩展名，非 `.srs` 一律 `source`，而 `source` 只接受 sing-box JSON。
  上游不提供 `.srs` 也不提供 JSON，所以必须自托管 JSON。
- **`route.final` 被硬编码为「第一个非 DNS 策略组」**，会忽略 ini 里的 `[]FINAL`。
  因此 sing-box 版的兜底是 ini 里第一个策略组（本项目是 `🚀 节点选择`）。
  这不是本项目能修的 bug，是 MiSub 的固定行为，只能在文档里说明。

### 1.4 策略组修剪：ini 走的是 `applySmartModelOptimizations`，不是 `pruneProxyGroups`

`pruneProxyGroups`（含「非顶级组不得引用 `🚀 节点选择`」那条）只被 builtin 生成器调用，
**不作用于 ini 模板**。ini 走 `template-processor.js` 的 `applySmartModelOptimizations`，
其中始终执行的是：

```
resolveGroupFilters → dedupeGroupsByName → pruneInvalidMembers → pruneEmptyGroups
```

- `pruneInvalidMembers` 只删「不在 proxies/groups/DIRECT/REJECT 里」的成员 —— 组名合法，不会被删。
- `pruneEmptyGroups` 删掉既无成员也无过滤器的组，**并连带删除指向它的规则**。
  所以每个组都必须非空：本项目的组都至少带 `DIRECT` / `REJECT` 字面成员。
- `.*` 被解析成 **filter** 而非成员，随后由 `resolveGroupFilters` 展开成实际节点名。

---

## 2. mihomo 侧语义（匹配端）

### 2.1 `behavior: domain` 的三种前缀

`component/trie/domain_set.go`：

```go
if parts[0] == complexWildcard {   // '+'
    b.insert(parts[1:])   // 自身（精确）
    b.insert(parts)       // 自身 + 所有子域（后缀）
} else {
    b.insert(parts)       // 仅精确匹配
}
```

| 上游写法 | 语义 | 等价 Clash 规则 |
|---|---|---|
| `+.example.com` | 自身 + 所有子域 | `DOMAIN-SUFFIX,example.com` |
| `example.com` | **仅精确匹配** | `DOMAIN,example.com` |
| `.example.com` | 仅子域 | 无精确等价（本项目按 `DOMAIN-SUFFIX` 处理，实测该形态出现 0 次） |

**这是整个转换最容易出错的地方。** 把裸域名误当后缀会多匹配几十万条子域，
把 `+.x` 误当精确匹配则会让规则几乎全部失效，而且两种错误都不会报错 —— 只是静默不生效。

### 2.2 `behavior: classical` 要求完整规则语法

classical 的 payload 每一行都交给规则解析器按 `TYPE,PAYLOAD` 解析。
裸域名（无逗号）会解析失败。所以本项目产出的 classical 规则集每行都带类型前缀：

```
DOMAIN-SUFFIX,example.com
DOMAIN,example.com
IP-CIDR,1.0.1.0/24
IP-CIDR6,2400:3200::/32
```

`rule-provider` 的 `behavior` 由客户端配置声明、不写在数据文件里 ——
所以 MiSub 给什么就必须用什么，这一点由 1.2 决定。

---

## 3. Loyalsoldier 上游数据形态

以 `release` 分支实际下载的样本为准：

| 文件 | 条目 | 形态 |
|---|---|---|
| `reject.txt` | 194,969 | YAML `payload:`，100% `'+.domain'` |
| `direct.txt` | 110,516 | 同左，但含 554 条裸域名（精确匹配） |
| `proxy.txt` | 27,239 | 同左，含 756 条裸域名 |
| `cncidr.txt` | 10,009 | CIDR，v4 / v6 混排（v6 约 3483 条） |
| `telegramcidr.txt` / `lancidr.txt` | 12 / 18 | 同上 |
| `private.txt` | 132 | 域名，含 14 条裸域名 |
| `apple.txt` / `google.txt` / `icloud.txt` | 165 / 112 / 53 | 域名，全 `'+.'` |
| `gfw.txt` / `tld-not-cn.txt` | 4,432 / 829 | 域名，仅黑名单模式使用，本项目不产出 |
| `applications.txt` | 99 | `PROCESS-NAME,...`，本项目不采用（见 README 差异说明） |

文件虽以 `.txt` 结尾，内容却是 YAML。**不要被扩展名骗了。**

---

## 4. 转换映射

| 上游条目 | Clash payload | sing-box JSON |
|---|---|---|
| `'+.x'` | `DOMAIN-SUFFIX,x` | `domain_suffix: ["x"]` |
| `'x'`（裸） | `DOMAIN,x` | `domain: ["x"]` |
| `a.b.c.d/nn` | `IP-CIDR,a.b.c.d/nn` | `ip_cidr: [...]` |
| 含 `:` 的 CIDR | `IP-CIDR6,…` | 同上（sing-box 的 `ip_cidr` 自识别 v4/v6） |

sing-box 规则集形态（`version: 3`）：

```json
{"version":3,"rules":[{"domain_suffix":["a.com"],"domain":["b.com"]}]}
```

同一个 rule 对象内 `domain` 与 `domain_suffix` 是 **OR** 关系（sing-box 把 domain\* 字段
视为同一匹配组），所以混装是安全的；但**不能**把 `domain_suffix` 与 `ip_cidr` 放进同一个
rule —— 不同匹配组之间是 **AND**，会变成永不命中的条件。

---

## 5. 白名单模式的顺序约束

严格复刻 Loyalsoldier README 的推荐顺序。两条容易踩的线：

1. `google`（PROXY）排在 `direct`（DIRECT）**之前**。两表重叠的域名以前者为准。
2. `FINAL` 必须是最后一条，否则白名单语义（未命中即代理）失效。

`--verify` 会为每张表取首条条目，模拟「先命中哪张表」，一旦顺序被改乱立刻失败。
该检查用 `suffixSet` / `exactSet` 做「逐级剥离子域」的判定，与 mihomo 的 trie 语义一致。

### 5.1 聚合（`agg-*`）的额外约束

把多张表合并成一个文件时，有三条不能破的线：

1. **一个规则集文件只能绑定一个策略组。**
   `rule-providers` 的 classical payload 每行只是 `TYPE,VALUE`，**不带 policy**，
   policy 由引用它的 `RULE-SET,<name>,<policy>` 决定。同一文件被多个策略组引用时，
   全部流量会被第一条规则吃掉。所以「文件数 ≥ 策略组数」，语义不变的实测下界是 4。

2. **sing-box 侧必须把域名和 IP 拆成多条 rule。**
   规则集 v3 的 `rules` 数组是 **OR**（任一匹配即属于该集合），
   而单个 rule 对象里的多字段是 **AND**。混合表若写成
   `{"domain_suffix":[...],"ip_cidr":[...]}`，等于要求「域名后缀命中 且 IP 同时命中」，
   永远不成立且不报错 —— 静默失效。

3. **跨组不能去重，组内必须去重。**
   跨表重叠是有语义的：`proxy ∩ direct = 158` 条，靠「proxy 表排在 direct 之前」才走代理，
   合并到不同组时绝不能删任何一边。而同一组内重复的条目（如 `direct` 表自身的 4 条重复）
   可以且应该去掉，去重时必须**保留首次出现顺序**。

`buildAggregates()` 对每张聚合表做三项自检：内部无重复、各源条目全包含、条目数只能变小。

---

## 6. 验证方法

```bash
# 结构 + 顺序（零依赖，可离线）
node scripts/loyalsoldier2misub.mjs --out-dir output --all-presets --verify

# 权威口径：MiSub 官方渲染管线（需 clone MiSub 并 npm install）
node scripts/verify-with-misub.mjs --misub /path/to/MiSub <ini...>

# 产物一致性：两次构建逐文件比对（仅归一化时间戳）
node scripts/check-consistency.mjs --left dist --right /tmp/dist2

# 发布后链接体检
node scripts/check-links.mjs --owner <owner> --repo misub-rules
```

### 已知盲区（工具覆盖不到的部分）

- **没有跑真的 mihomo / sing-box 内核。** 规则文件的合法性是用 js-yaml 解析 + 规则类型
  白名单校验来近似的，不等于内核真的能加载。改动规则集格式后，务必至少用一个真实客户端
  导入一次。
- **jsDelivr 分支缓存约 12 小时。** 推送后 `raw` 立刻是新版，CDN 仍是旧版属正常现象。
  purge（`POST https://purge.jsdelivr.net/`）只清边缘，内部还有一层会按需回填，
  purge 完立刻测会自我欺骗 —— 要静置约 60 秒后再单次实测。
- **sing-box 的兜底策略不受 ini 控制**（见 1.3），验证只能确认它存在，不能改变它。

---

## 7. 改动产物格式前的检查清单

- [ ] `custom_proxy_group=` 仍在 `[custom]` 段内，没有引入 `[proxy group]` 段头
- [ ] 规则集 URL 以 `.yaml`（Clash）或 `.json`（sing-box）结尾，且不含逗号
- [ ] 规则集内容是全语法（带 `DOMAIN-SUFFIX,` / `IP-CIDR,` 前缀）
- [ ] 每个策略组至少有一个 `[]` 成员或 `.*` 过滤器
- [ ] 规则指向的策略组都存在
- [ ] `[]FINAL` 唯一且位于末尾
- [ ] 新增 / 改名产物文件时，**同步产出 `SubBoost_*` 兼容副本**，否则旧订阅链接会 404
- [ ] 聚合表：一个文件只对一个策略组；sing-box 侧域名与 IP 拆成两条 rule；跨组不去重
- [ ] 跑完第 6 节的四条命令，并用真实客户端导入一次
