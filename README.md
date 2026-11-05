# misub-rules

把 [SubBoost](https://github.com/SubBoost/subboost) 的预设分流规则，转换成
[MiSub](https://github.com/imzyb/MiSub) 可直接引用的规则模板与远程规则集。

产物发布在 `dist` 分支，每日由 GitHub Actions 自动重建。

---

## 可用链接

### 规则模板（内联写法，Clash / Mihomo 与 sing-box 通用）

| 预设 | 规则数 | 链接 |
|---|---|---|
| 完整版 | 93 | `https://cdn.jsdelivr.net/gh/n2far2000/misub-rules@dist/misub/SubBoost_Full_MiSub.ini` |
| 标准版 | 23 | `https://cdn.jsdelivr.net/gh/n2far2000/misub-rules@dist/misub/SubBoost_Standard_MiSub.ini` |
| 精简版 | 8 | `https://cdn.jsdelivr.net/gh/n2far2000/misub-rules@dist/misub/SubBoost_Minimal_MiSub.ini` |

### 远程规则集版（一份 ini 只适用一个内核）

| 内核 | 链接 |
|---|---|
| Clash / Mihomo | `https://cdn.jsdelivr.net/gh/n2far2000/misub-rules@dist/misub-remote/SubBoost_<Preset>_MiSub_clash.ini` |
| sing-box | `https://cdn.jsdelivr.net/gh/n2far2000/misub-rules@dist/misub-remote/SubBoost_<Preset>_MiSub_singbox.ini` |

### 元信息

- `https://cdn.jsdelivr.net/gh/n2far2000/misub-rules@dist/manifest.json`
- `https://cdn.jsdelivr.net/gh/n2far2000/misub-rules@dist/upstream.json`

> `cdn.jsdelivr.net` 偶发不稳时可换 `raw.githubusercontent.com/n2far2000/misub-rules/dist/…`。
> jsDelivr 对**分支引用**有缓存（最长约 12 小时），需要立即生效请用 raw。

---

## 用法

MiSub → **设置** → **规则与配置方案** → **规则来源** 选「自定义远程规则 URL」
→ 在**模板配置**填入上表任一链接 → 保存。

---

## 产物说明

- **规则模板**用 `[]GEOSITE` / `[]GEOIP,no-resolve` 的内联写法，规则集不下发，
  域名数据来自客户端 geodata，Clash 与 sing-box 双端都正确。
- **远程规则集版**供需要自托管规则内容的场景，域名与 IP 分别产出，
  因此必须按内核各用一份 ini。
- 规则顺序严格复刻 SubBoost `rules.ts` 的 canonical 顺序。

> `[]GEOIP,…,no-resolve` 需要渲染器支持 `rule.extras` 透传；未支持的 MiSub 会静默丢弃
> 该修饰符，行为退化为「每个域名连接解析一次」。

设计依据（MiSub 渲染器的源码级约束）见 [docs/internals.md](docs/internals.md)。

---

## 许可

[AGPL-3.0-only](LICENSE)。产物派生自
[SubBoost](https://github.com/SubBoost/subboost)（AGPL-3.0）、
[MetaCubeX/meta-rules-dat](https://github.com/MetaCubeX/meta-rules-dat)（GPL-3.0）、
[v2fly/domain-list-community](https://github.com/v2fly/domain-list-community)（MIT），
完整归属见 [NOTICE](NOTICE)。
