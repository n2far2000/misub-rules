# misub-rules

[![Update rules](https://github.com/n2far2000/misub-rules/actions/workflows/update.yml/badge.svg)](https://github.com/n2far2000/misub-rules/actions/workflows/update.yml)
[![License: AGPL-3.0-only](https://img.shields.io/badge/license-AGPL--3.0--only-blue.svg)](LICENSE)

将 [SubBoost](https://github.com/SubBoost/subboost) 的预设分流规则转换为
[MiSub](https://github.com/imzyb/MiSub) 可直接引用的规则模板与远程规则集，
每日由 GitHub Actions 自动重建，经 jsDelivr 分发到国内可直连的链接。

生成逻辑完全来自**解析上游源码**：规则模块、规则顺序、预设启用清单、默认开关
均直接读取 SubBoost 的 TypeScript 定义，不依赖人工抄写。上游变更后产物随之更新。

---

## 目录

- [简介](#简介)
- [特性](#特性)
- [快速开始](#快速开始)
- [可用链接](#可用链接)
- [两种产物形态](#两种产物形态)
- [本地模式](#本地模式)
- [兼容性](#兼容性)
- [工作原理](#工作原理)
- [常见问题](#常见问题)
- [目录结构](#目录结构)
- [许可与署名](#许可与署名)

---

## 简介

SubBoost 的规则定义面向其自身的生成器，MiSub 无法直接消费；而 MiSub 的规则模板
需要手工维护，上游一有变动就必须重新跟进。本项目位于两者之间：

```
SubBoost 上游源码  ──解析──▶  生成器  ──输出──▶  MiSub 模板 / 远程规则集  ──▶  jsDelivr  ──▶  客户端
     (每日拉取)                              (GitHub Actions)                    (CDN)
```

转换结果同时覆盖 Clash / Mihomo 与 sing-box 两类内核，且整个链路可重复、可校验：
生成阶段即复刻 MiSub 的解析与剪枝逻辑做端到端模拟，任何结构缺陷都会导致构建失败，
不产出不可用的配置。

## 特性

| 特性 | 说明 |
|---|---|
| 三套预设 | 完整版（93 条规则 / 33 个策略组）、标准版、精简版，覆盖全量分流到轻量够用 |
| 双内核正确 | 内联 `GEOSITE` 写法在 Clash 与 sing-box 下均正确渲染，无需为不同客户端分别准备模板 |
| 远程规则集按内核分格式 | 同时产出 classical（Clash）与 source（sing-box）两套格式，解决两个内核对远程规则集格式要求互斥的问题 |
| 生成即校验 | 复刻 MiSub 解析器与剪枝逻辑做端到端模拟，空策略组、悬空引用、顺序丢失均会导致构建失败 |
| geodata 分类联网核验 | 逐个确认 geosite / geoip 分类存在于 MetaCubeX，避免生成内核无法加载的规则 |
| 结构变更可感知 | `upstream.json` 记录结构指纹，指纹变化即表示模板需要重新导入或重新选取 |

## 快速开始

MiSub 支持两种接入方式，按是否需要手工维护选择。

### 方式一：引用远程模板 URL（推荐）

MiSub 原生支持将远程 `.ini` 文件作为规则模板来源，配置后无需任何手工粘贴，
上游结构变化也会自动跟随。

1. 打开 MiSub → **设置** → **规则与配置方案**
2. 将 **1. 规则来源** 设为 **自定义远程规则 URL**
3. 在 **2. 模板配置** 的输入框中填入：

   ```
   https://cdn.jsdelivr.net/gh/n2far2000/misub-rules@dist/misub/SubBoost_Full_MiSub.ini
   ```

4. 保存

MiSub 会在生成订阅时按需拉取该地址，并按 `ETag` / `Last-Modified` 做条件请求。

### 方式二：保存为本地模板

适用于网络受限、或需要对模板做本地改动的场景。

1. 打开 [完整版模板链接](https://cdn.jsdelivr.net/gh/n2far2000/misub-rules@dist/misub/SubBoost_Full_MiSub.ini)，复制全文
2. MiSub → **自定义规则模板** → **新建模板** → 粘贴 → 保存
3. 将 **规则来源** 设为 **自定义规则模板**，并选中刚保存的模板

> MiSub 的本地模板库通过 `POST /api/rule-templates` 写入，只接受模板内容，
> 单份上限 128 KB（完整版约 9.4 KB）。上游**结构**变化时需重新导入一次。

### 方式三：本地生成

克隆仓库后在本地运行生成器，可完全离线复现产物，详见[本地模式](#本地模式)。

## 可用链接

所有产物发布在 **`dist` 分支**，通过 jsDelivr 访问。

### MiSub 规则模板

| 预设 | 链接 |
|---|---|
| **完整版**（推荐） | `https://cdn.jsdelivr.net/gh/n2far2000/misub-rules@dist/misub/SubBoost_Full_MiSub.ini` |
| 标准版 | `https://cdn.jsdelivr.net/gh/n2far2000/misub-rules@dist/misub/SubBoost_Standard_MiSub.ini` |
| 精简版 | `https://cdn.jsdelivr.net/gh/n2far2000/misub-rules@dist/misub/SubBoost_Minimal_MiSub.ini` |

### 远程规则集版

| 目标内核 | 链接 |
|---|---|
| Clash / Mihomo | `https://cdn.jsdelivr.net/gh/n2far2000/misub-rules@dist/misub-remote/SubBoost_Full_MiSub_clash.ini` |
| sing-box | `https://cdn.jsdelivr.net/gh/n2far2000/misub-rules@dist/misub-remote/SubBoost_Full_MiSub_singbox.ini` |

### 元信息

| 文件 | 内容 |
|---|---|
| `...@dist/manifest.json` | 构建时间、三预设的规则与策略组数量、文件 sha256 |
| `...@dist/upstream.json` | 上游结构指纹，用于判断是否需要重新导入模板 |

**镜像前缀**：主域名偶发不稳时，可将 `cdn.jsdelivr.net` 替换为
`fastly.jsdelivr.net`、`testingcf.jsdelivr.net` 或 `gcore.jsdelivr.net`。

> jsDelivr 对**分支引用**的缓存约 12 小时，因此产物更新后最长半天全网生效。
> 需要立即生效可改用 `@<tag>` 或 `@<commit-sha>` 引用。

## 两种产物形态

|  | 内联版（`misub/`） | 远程规则集版（`misub-remote/`） |
|---|---|---|
| 规则写法 | `ruleset=组名,[]GEOSITE,ai` | `ruleset=组名,https://…/rules/clash/sb-ai.yaml` |
| Clash 行为 | 原生 `GEOSITE,ai,组` | 生成 `rule-providers`，`interval: 86400` |
| sing-box 行为 | 自动映射为 SagerNet `geosite-ai.srs` | 生成 `rule_set` remote，`update_interval: 24h` |
| 双端兼容 | **Clash 与 sing-box 均正确** | **一份 ini 仅适用于一个内核** |
| 域名数据来源 | 客户端自身的 geodata（自动更新） | 本仓库托管的规则集文件 |
| 适用场景 | 绝大多数情况，**默认选择** | 需要规则内容完全自主可控（自建域名、不依赖 geodata） |

远程规则集版需要分成两份 ini，原因在于 MiSub 对两个内核的远程规则集格式要求互斥：
Clash 渲染器将远程规则集的 `behavior` 固定为 `classical`，托管文件必须是完整的规则行；
sing-box 渲染器仅按扩展名判断格式（`.srs` → `binary`，其余 → `source`），
且其 `source` 格式只接受 JSON。单个 URL 无法同时满足两者，因此 `rules/` 下分别产出两套格式。
详细依据见 [docs/internals.md](docs/internals.md)。

## 本地模式

适用于离线复现、本地调试，或在修改生成逻辑后验证产物。

### 环境要求

- Node.js 18 或更高版本（CI 与开发环境使用 22）
- 零外部依赖，无需 `npm install`

### Windows 一键脚本

双击仓库根目录下的 `Update-SubBoost-MiSub.bat`，等价于执行
`node scripts\subboost2misub.mjs --verify --diff`。脚本会将参数原样透传：

```bat
Update-SubBoost-MiSub.bat                           :: 生成完整版
Update-SubBoost-MiSub.bat --preset standard         :: 生成标准版
Update-SubBoost-MiSub.bat --all-nodes               :: 策略组内展开全部节点
Update-SubBoost-MiSub.bat --offline                 :: 只用本地缓存，不联网
Update-SubBoost-MiSub.bat --dist dist --all-presets :: 生成完整产物目录
```

默认输出至仓库根目录的 `SubBoost_<Preset>_MiSub.ini`（已在 `.gitignore` 中忽略）。

### 命令行

```bash
# 仅生成一份 MiSub 模板
node scripts/subboost2misub.mjs --out SubBoost_Full_MiSub.ini --verify

# 生成完整产物（含远程规则集）
node scripts/subboost2misub.mjs --dist dist --all-presets \
  --gh-owner <owner> --gh-repo misub-rules --gh-ref dist --verify

# 离线重跑，使用 .work/ 下的缓存
node scripts/subboost2misub.mjs --dist dist --all-presets --offline \
  --gh-owner <owner> --gh-repo misub-rules --gh-ref dist
```

### 参数

| 参数 | 说明 |
|---|---|
| `--preset full\|standard\|minimal` | 单预设模式，默认 `full` |
| `--all-presets` | 三个预设全部生成 |
| `--out <file>` | 本地模式输出文件 |
| `--dist <dir>` | 产物模式输出目录 |
| `--gh-owner` / `--gh-repo` / `--gh-ref` | 拼接远程规则集的基础 URL |
| `--rule-base-url <url>` | 直接指定基础 URL，覆盖上述三项 |
| `--rules clash,singbox` | 生成哪些格式的远程规则集，`none` 表示跳过 |
| `--verify` | 复刻 MiSub 解析器做端到端校验（`--dist` 模式下默认开启） |
| `--verify-geodata` | 联网核验每个 geosite / geoip 分类是否存在 |
| `--geo-cache-ttl <min>` | geodata 本地缓存有效期，默认 1440 分钟，`0` 表示禁用 |
| `--offline` | 仅使用本地缓存，不发起网络请求 |
| `--all-nodes` | 业务策略组内展开全部节点 |
| `--diff` | 与上一次输出比对规则增删 |
| `--cache-dir` / `--geo-cache` | 缓存目录 |

### 验证产物

```bash
# 内置回归：复刻 MiSub 解析逻辑做端到端模拟，零依赖、可离线
node scripts/subboost2misub.mjs --out out.ini --verify

# 权威口径：直接加载 MiSub 源码的模板管线验证（需 MiSub 检出）
node scripts/verify-with-misub.mjs --misub /path/to/MiSub dist/misub/*.ini
```

`--verify` 复刻 MiSub 的解析与剪枝逻辑，适合日常回归；`verify-with-misub.mjs`
直接调用 MiSub 官方渲染器，用于核对复刻实现是否与上游一致。MiSub 升级版本后应重跑后者。
详见 [docs/internals.md](docs/internals.md)。

## 兼容性

以下结论来自对 MiSub v2.7.0 源码的核对，并已在本地用 MiSub 官方渲染管线
（`renderClashFromIniTemplate` / `renderSingboxFromIniTemplate`）对四种产物做过实机验证。
完整证据与约束清单见 [docs/internals.md](docs/internals.md)。

| 项 | 结论 |
|---|---|
| 远程 `.ini` 模板 URL | **原生支持**。规则来源选择 `自定义远程规则 URL`（`custom`）时，MiSub 会拉取该地址并按统一模板模型渲染 |
| 支持的输出格式 | Clash / sing-box / Surge / Loon / QuantumultX / Egern 六种，内置渲染引擎下均适用 |
| 扩展名要求 | 远程地址必须以 `.ini` 结尾 |
| 远程模板缓存 | 重新校验间隔默认 5 分钟，最大缓存 24 小时，支持 `ETag` / `Last-Modified` 条件请求 |
| 远程模板模式下的规则等级 | 强制为 `none`，不叠加 MiSub 内置规则等级（模板已自包含） |
| URL 安全限制 | 仅允许 HTTP/HTTPS，且禁止内网、回环与云元数据地址；jsDelivr 不受影响 |
| 本地模板库 | 只接受模板内容，无 URL 字段，单份上限 128 KB |

## 工作原理

```
GitHub Actions（每日北京时间 04:17，另有手动触发）
  ├─ 拉取 SubBoost 源码      proxy-group-modules / rules / proxy-groups / defaults
  ├─ 拉取 MetaCubeX geodata  92 个 geosite / geoip 明文列表
  ├─ 解析并重排规则          复刻 buildCanonicalRuleEntries() 的顺序逻辑
  ├─ 生成产物                ini 模板 + 远程规则集 + manifest
  ├─ 端到端校验              复刻 MiSub 解析器模拟渲染，失败则不发布
  └─ 发布                    dist 分支（孤立提交 + 强制推送）
                                   ↓
                             jsDelivr CDN → 客户端
```

`dist` 分支每次以**孤立提交 + 强制推送**重建，仓库体积恒等于单次产物大小，
不会随每日提交累积。同时，每日推送本身构成仓库活动，
可避免公开仓库因连续 60 天无活动而被自动禁用定时任务。

## 常见问题

**多久更新一次？**

GitHub Actions 每日北京时间 04:17 自动运行，也可在
[Actions 页面](https://github.com/n2far2000/misub-rules/actions/workflows/update.yml) 手动触发。

**更新后需要重新导入 MiSub 模板吗？**

采用方式一（远程 URL）时不需要。采用方式二（本地模板）时，日常的域名数据变化
不影响模板结构；仅当 Actions 摘要提示「结构变化 = true」时需要重新导入一次。

**为什么链接有时要等半天才更新？**

jsDelivr 对分支引用的缓存约 12 小时。需要立即生效可改用 `@<tag>` 或 `@<commit-sha>` 引用。

**可以直接使用 `raw.githubusercontent.com` 吗？**

可以，但国内访问经常不通，这是选用 jsDelivr 的原因。MiSub 自身也会将
`raw.githubusercontent.com` 自动重写为 jsDelivr 地址。

**用 jsDelivr 下载 `Update-SubBoost-MiSub.bat` 返回 403？**

这是 jsDelivr 的平台策略：所有可执行类扩展名（`.bat`/`.cmd`/`.exe`/`.ps1` 等）
一律拒绝服务，与文件内容和仓库无关。该启动器本就设计为**本地使用**——请从
仓库页面直接查看，或 `git clone` 后双击；不要通过 CDN 引用它。

**Fork 后生成的链接不可用？**

链接中的 `n2far2000/misub-rules` 为硬编码。需在运行时通过 `--gh-owner` / `--gh-repo`
指定自己的仓库，并替换 README 中的对应链接。

## 目录结构

```
.github/workflows/update.yml      每日自动重建工作流
scripts/subboost2misub.mjs        生成器（零依赖）
scripts/verify-with-misub.mjs     用 MiSub 官方渲染器验证产物
scripts/check-links.mjs           全量链接体检：枚举两分支所有文件 × 三通道实测
Update-SubBoost-MiSub.bat         Windows 本地模式启动器
docs/internals.md                 源码级约束与设计依据（维护者参考）
push.sh                           首次推送到 GitHub 的脚本
LICENSE                           AGPL-3.0 全文
NOTICE                            上游归属与许可说明
README.md
.gitattributes                    换行符规范（.bat 保持 CRLF）
.work/                            上游源码与 geodata 缓存（已忽略）
dist/                             构建产物（已忽略，实际发布在 dist 分支）
```

## 许可与署名

本项目以 **AGPL-3.0-only** 分发，全文见 [LICENSE](LICENSE)。

产物派生自以下项目，详细归属与许可说明见 [NOTICE](NOTICE)：

| 上游 | 许可 |
|---|---|
| [SubBoost/subboost](https://github.com/SubBoost/subboost) | AGPL-3.0-only |
| [MetaCubeX/meta-rules-dat](https://github.com/MetaCubeX/meta-rules-dat) | GPL-3.0 |
| [v2fly/domain-list-community](https://github.com/v2fly/domain-list-community) | MIT |
| [imzyb/MiSub](https://github.com/imzyb/MiSub) | MIT |
