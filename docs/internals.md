# 设计依据与内部约束

本文档面向维护者，记录生成器的设计依据、MiSub 与 SubBoost 两侧的**源码级事实**，
以及修改产物格式前必须遵守的约束。

文中所有结论均来自实际读取上游源码，而非文档描述或经验推断。
核对基线：

| 上游 | 版本 / 引用 | 核对日期 |
|---|---|---|
| [imzyb/MiSub](https://github.com/imzyb/MiSub) | v2.7.0（`main`） | 2026-10-01 |
| [SubBoost/subboost](https://github.com/SubBoost/subboost) | `main` | 2026-10-01 |
| [MetaCubeX/meta-rules-dat](https://github.com/MetaCubeX/meta-rules-dat) | `meta` 分支 | 2026-10-01 |

> 上游若调整实现，本文档的结论可能失效。修改产物格式前请先按
> [第 4 节](#4-验证方法) 重新验证。

---

## 1. MiSub 侧（消费端）

### 1.1 规则模板的接入方式

MiSub 支持两种规则模板来源，二者并存但机制不同。

**（一）本地模板库**

MiSub 将模板内容存放在自身 KV 中，通过 `POST /api/rule-templates` 管理：

- 请求体只接受 `content` 等字段，**没有 URL 字段**（`functions/modules/rule-template-handler.js`）
- 内容长度上限 `MAX_TEMPLATE_CONTENT_LENGTH = 128 * 1024`
- 内容需通过 `hasIniShape()` 校验，即至少含 `[custom]` / `[proxy group]` / `[rule]` / `[ruleset]` / `[proxy]` 之一
- 引用方式为 `custom:<模板ID>`

**（二）远程模板 URL**

这是 MiSub 的原生能力，无需手工粘贴：

```
settings.transformConfigMode = 'custom'
  └─ resolveTemplateUrl()            main-handler.js
       └─ resolveTemplateSource()    非 builtin: / custom: 前缀 → { kind: 'remote' }
            └─ fetchTransformTemplate()             transform-template-cache.js
                 └─ renderClashFromIniTemplate()    processor-service.js
                    renderSingboxFromIniTemplate()
                    renderSurgeFromIniTemplate()
                    renderLoonFromIniTemplate()
                    renderQuanxFromIniTemplate()
                    renderEgernFromIniTemplate()
```

相关约束：

| 项 | 行为 | 位置 |
|---|---|---|
| 扩展名 | 远程地址必须以 `.ini` 结尾 | `processor-service.js` → `isIniTemplateSource()` |
| 支持格式 | Clash / sing-box / Surge / Loon / QuantumultX / Egern | `template-compatibility.js` → `TEMPLATE_COMPATIBILITY` |
| 缓存 | 重新校验间隔默认 5 分钟，最大缓存 24 小时 | `transform-template-cache.js` |
| 条件请求 | 缓存有效时携带 `If-None-Match` / `If-Modified-Since` | `buildFetchHeaders()` |
| 规则等级 | 远程模板模式下强制 `ruleLevel = 'none'` | `main-handler.js` |
| URL 校验 | 仅 HTTP/HTTPS；禁止 localhost、内网段、`*.local` / `*.internal`、云元数据地址 | `security-utils.js` → `validatePublicNetworkUrl()` |

缓存周期可通过环境变量覆盖：
`TEMPLATE_REVALIDATE_INTERVAL_SECONDS`（0 ～ 86400）、`TEMPLATE_CACHE_MAX_AGE_SECONDS`（300 ～ 604800）。

UI 位置对应关系：

| 界面 | 选项文案 | 内部值 |
|---|---|---|
| 设置 → 规则与配置方案 → 1. 规则来源 | 使用内置自动分流 | `builtin` |
|  | 选择预设规则模板 | `preset` |
|  | **自定义远程规则 URL** | `custom` |
|  | 自定义规则模板 | `custom_template` |
| 订阅组 → 方案选择 | 跟随全局设置 | `global` |

选择 `custom` 后，下方的模板配置输入框占位文案为「输入远程 .ini 配置文件 URL」。

### 1.2 ini 解析器

`template-parsers/ini-template-parser.js`：

- 仅消费三个 section：`custom`、`proxy group`、`rule`，其余 section 被忽略
- `custom` section 内额外识别 ACL4SSR 风格的两类行：`custom_proxy_group=` 与 `ruleset=`
- `ruleset=策略名,源` 的解析分两路：
  - 源以 `[]` 开头 → 内联规则，如 `[]GEOSITE,ai`、`[]GEOIP,CN`、`[]FINAL`
  - 否则视为远程规则集 URL，并经 `pinRemoteRuleUrl()` 处理
- `pinRemoteRuleUrl()` 仅对 `raw.githubusercontent.com` 做改写（部分仓库还会钉住 revision 到 jsDelivr），
  其他域名原样保留

**规则装配顺序**（务必注意）：

```js
const rules = (sections.get('rule') || []).map(parseRuleLine).filter(Boolean)
    .concat(parsedAclRules);   // ← 位于 [rule] 的规则排在所有 ruleset= 之前
```

因此规则必须统一走 `ruleset=` 行。若把规则写进 `[rule]`，它们会被整体前置到规则表开头，
破坏分流优先级。

### 1.3 空策略组剪枝

`template-processor.js` 的 `applySmartModelOptimizations()` 会移除没有任何成员的策略组，
并**连带删除所有指向该组的规则**。

这意味着 `custom_proxy_group=某组=select` 这类无成员定义是危险写法：引用它的规则会静默消失，
最终配置看起来正常但分流大面积失效。生成器已将所有策略组填充为真实成员
（组引用、`.*`、`DIRECT` / `REJECT`）来规避。

### 1.4 远程规则集：两个内核的格式要求互斥

ini 中的 `ruleset=组名,<http URL>` 在两个渲染器中的处理方式不同。

**Clash**（`template-renderers/render-clash.js`）

```js
function getRuleProviderBehavior(providerUrl) {
    const fileName = basename(providerUrl).replace(/\.(yaml|yml|list|txt|conf)$/i, '');
    if (ACL4SSR_IPCIDR_PROVIDER_FILES.has(fileName.toLowerCase())) return 'ipcidr';
    return 'classical';
}
// ACL4SSR_IPCIDR_PROVIDER_FILES = { amazonip, chinacompanyip, chinaip, chinaipv6, netflixip }
```

除这五个文件名外一律为 `classical`，**没有 `domain` 行为**。因此托管文件必须是完整的
规则行形式（YAML `payload:` 或纯文本均可）。生成器统一以 `sb-` 前缀命名，确保永不落入
`ipcidr` 白名单。

**sing-box**（`template-renderers/render-singbox.js`）

```js
function detectRuleSetFormat(url) {
    return url.endsWith('.srs') ? 'binary' : 'source';
}
```

扩展名是唯一判据，且 sing-box 的 `source` 格式**只接受 JSON**
（`{"version":1,"rules":[...]}`），YAML 不被支持。

**结论**：单个 URL 无法同时满足两个内核，因此远程规则集版必须产出两套格式与两份 ini。
内联 `[]GEOSITE,x` 则没有这个问题——Clash 输出原生 `GEOSITE` 规则，sing-box 自动映射到
SagerNet 的 `.srs`，故内联版为主推产物。

### 1.5 输出端的其余约束

- **sing-box 的域名与 IP 不能放在同一个 rule 对象内**。sing-box 的匹配语义是
  「组内 OR、组间 AND」，把 `domain_suffix` 与 `ip_cidr` 放进同一对象会变成永假条件。
  生成器会将这类混合段拆成两个 rule 对象。
- **GEOIP 的 `no-resolve` 在 Clash 渲染器中被丢弃**，这是渲染器行为，非产物缺陷。
- **surge / loon / quanx / egern** 亦经由统一模板模型渲染，但本项目未针对这些格式做产物级验证。

---

## 2. SubBoost 侧（来源端）

生成器解析以下文件，不执行 TypeScript，仅做结构化提取：

| 文件 | 提取内容 |
|---|---|
| `packages/core/src/generator/module-rules.ts` | 规则模块定义（36 个模块） |
| `packages/core/src/generator/proxy-group-modules.ts` | 代理组模块定义 |
| `packages/core/src/generator/proxy-groups.ts` | 代理组成员构成、`groupType` 语义 |
| `packages/core/src/generator/rules.ts` | 规则最终排序（`buildCanonicalRuleEntries()`） |
| `packages/core/src/config/defaults.ts` | 预设启用清单与默认开关 |

需要注意的上游行为：

- **规则顺序不可自行编排**。SubBoost 在 `rules.ts` 中按固定顺序装配规则，
  其中包含若干位置特例（例如 `apple-tvplus` 会插到 apple 相关规则的位置）。
  生成器复刻该顺序，而不是按组名重新排序。
- **`case "full":` 分支为空**，靠 fallthrough 落到 `default:`。解析预设启用清单时若按
  常规方式按 `case` 切分，会漏掉排除清单，导致被排除的模块（adult / gemini / google-scholar）
  被误开。
- **`experimentalCnUseCnRuleSet` 默认为 `true`**。启用时 `rules.ts` 会在
  `geolocation-!cn` 之后、兜底规则之前补入一条完整国内域名规则（产物中的 `[]GEOSITE,cn`）。
  该开关位于 `defaults.ts`，容易漏读。
- **代理组成员的构建依赖 `groupType`**。`direct-first` 类组的 `DIRECT` 排在首位，
  `reject-first` 类组 `REJECT` 在首位，这些顺序会影响客户端默认选中项。
- 完整版（`full`）实际启用 33 个策略组、93 条规则，对应 32 个规则集分段。

规则顺序（完整版，自上而下）：

```
广告拦截 → 私有网络 → AI 服务 → 国内服务（高置信：geolocation-cn + GEOIP CN）
→ YouTube → 教育学术 → 云服务 → 谷歌服务 → 电报消息 → 代码托管 → 通讯服务
→ 流媒体 · 社交 · 游戏 · 开发工具 · 网盘 · 支付 · 新闻 · 海淘（各服务细分）
→ 非中国（geolocation-!cn）→ 国内服务补充（cn）→ 兜底（FINAL）
```

---

## 3. 生成器约束清单（改动前必读）

以下每条都对应一个可导致「配置看起来正常但实际不生效」的缺陷：

1. MiSub 只识别 `[custom]` / `[proxy group]` / `[rule]` 三个 section，其余被忽略。
2. 规则必须走 `ruleset=` 行。写入 `[rule]` 会被整体前置，破坏分流优先级。
3. `custom_proxy_group=` 的成员必须真实存在。空策略组会被剪枝，指向它的规则被一并删除。
4. `geosite/*.list` 中的 `+.` 前缀不属于域名本身。MetaCubeX 明文列表大量使用
   `+.example.com`（`cn.list` 为 100%），语义与裸域名相同，均表示「本域及子域」。
   未剥离会产出 `DOMAIN-SUFFIX,+.xxx` 这类永不命中的废规则。
5. sing-box 的域名与 IP 必须拆成两个 rule 对象，否则构成永假条件。
6. 远程规则集按「连续且同策略组」聚合，不得按组名跨段合并。SubBoost 会让同一策略组
   的规则在配置中出现不相邻的多段，跨段合并会改变命中顺序。
7. 远程规则集文件名必须避开 `amazonip` / `chinacompanyip` / `chinaip` / `chinaipv6` /
   `netflixip`，否则会被判定为 `ipcidr` 行为而解析失败。本项目统一使用 `sb-` 前缀。
8. 远程规则集 URL 的扩展名决定 sing-box 的解析格式：`.srs` 视为 `binary`，其余视为
   `source`（仅 JSON）。Clash 与 sing-box 需要不同的托管文件。

生成器内置了两道防线：`assertCleanPayload()` 在写出前拒绝任何含残留语法字符的规则行；
`--verify` 复刻 MiSub 解析器做端到端模拟，任一约束被违反即终止构建且不写文件。

---

## 4. 验证方法

### 4.1 快速回归（内置模拟）

```bash
node scripts/subboost2misub.mjs --out out.ini --verify
```

复刻 MiSub 的解析与剪枝逻辑在本地跑一遍，零依赖、可离线。用于日常改动后的回归。

### 4.2 权威口径（MiSub 官方渲染器）

模拟终究是复刻实现，可能与上游产生偏差。`scripts/verify-with-misub.mjs` 直接加载
MiSub 源码中的模板管线做验证：

```bash
git clone --depth 1 https://github.com/imzyb/MiSub /tmp/MiSub
cd /tmp/MiSub && npm install && cd -

node scripts/verify-with-misub.mjs --misub /tmp/MiSub \
  dist/misub/SubBoost_Full_MiSub.ini \
  dist/misub-remote/SubBoost_Full_MiSub_clash.ini
```

校验内容：产出为合法 YAML / JSON、规则与策略组数量非零、无悬空策略引用、
无空策略组、`MATCH` 兜底位于末位、sing-box 的 remote `rule_set` 均带 `url`。

**上游升级 MiSub 版本后应重跑此项。**

### 4.3 geodata 分类名称核验

```bash
node scripts/subboost2misub.mjs --verify --verify-geodata --out /dev/null
```

对每个 `GEOSITE` / `GEOIP` 分类名发起 HTTP 请求确认其在 MetaCubeX 存在
（回落 v2fly）。注意 MetaCubeX 的 `geoip/*.list` 文件名是小写，
核验时需做大小写归一。

---

## 5. 已知限制

| 限制 | 原因 | 影响 |
|---|---|---|
| 远程规则集版需两份 ini | 两个内核对远程规则集的格式要求互斥 | 跨客户端使用时需分别配置 |
| `GEOIP` 的 `no-resolve` 不生效 | MiSub 的 Clash 渲染器丢弃该附加参数 | 影响极小 |
| sing-box 输出中非国家类 `GEOIP` 可能缺个别类别 | 映射到 SagerNet 规则集时并非全部类别都有对应 | 仅影响 sing-box 端的少数分类 |
| 业务策略组默认不展开全部节点 | 与 SubBoost「组内直列节点」的做法不同 | 需要时加 `--all-nodes` |
| 产物更新最长半天才全网生效 | jsDelivr 对分支引用的缓存约 12 小时 | 需要即时生效可改用 tag 或 commit sha 引用 |
