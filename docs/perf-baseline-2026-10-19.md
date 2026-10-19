# 客户端侧性能基线（2026-10-19 实测）

针对「刷新订阅 / 切换订阅显著卡顿，Sparkle 概率性内核崩溃」的定位记录。
所有数字来自本机实测（Windows 10、江西电信、mihomo v1.19.32 go1.26.8），
客户端为 Sparkle（内核 mihomo）与 Clash Verge。

---

## 1. 结论速览

两个独立问题，不要混为一谈：

| 症状 | 真正原因 | 可改的变量 |
|---|---|---|
| 刷新 / 切换订阅卡顿 | 拉 4 个 rule-provider 走 **DIRECT**，jsDelivr 冷缓存要 50 秒 | 传输通道 |
| Sparkle 概率性崩溃 | reload 期间峰值内存 **121 MB**，且 YAML 解析有瞬时分配 | 规则存储格式（mrs） |

`behavior` 从 `classical` 改 `domain` **对内存无效**（81.2 vs 84.1 MB），这是常见误区。

---

## 2. 传输通道实测

四个聚合表合计 12.15 MB（brotli 压缩后 1.58 + 0.9 + 0.03 MB 量级），
mihomo 拉 provider 默认 `proxy: DIRECT`，不跟随客户端代理设置。

| 通道 | 第 1 轮 | 第 2 轮 | 第 3 轮 | 备注 |
|---|---|---|---|---|
| `gh-proxy.com` | 3.4 s | 2.8 s | 4.1 s | 加速版采用 |
| `cdn.jsdelivr.net`（热） | 10.1 s | 12.6 s | 12.6 s | 主链接 |
| `cdn.jsdelivr.net`（冷） | **50 s** | — | — | 边缘 MISS 回源 |
| `fastly.jsdelivr.net` | 95.2 s | — | — | |
| `ghfast.top` | — | — | 12.9 s | |
| `ghproxy.net` | 单文件 39 KB/s | — | — | 不可用 |
| `hub.gitmirror.com` | 连接失败 | — | — | 不可用 |

内容完整性：四个聚合表经 gh-proxy 下载后逐个 md5 与源站比对，**全部一致**。

### 2.1 为什么不能用裸 raw

MiSub `functions/modules/subscription/builtin-rules-provider.js:500`：

```js
if (!/raw\.githubusercontent\.com$/i.test(url.hostname)) return raw;
if (mirror) return `https://cdn.jsdelivr.net/gh/${owner}/${repo}@${ref}/...`;
```

写 `raw.githubusercontent.com` 直链会被 MiSub **静默改回 jsDelivr**。
必须让 host 变成代理域名本身（`https://gh-proxy.com/https://raw.githubusercontent.com/...`）。

---

## 3. reload 与峰值内存

方法：进程启动 → `/providers/rules` 报 `ruleCount` 就绪 → 追加 3 次
`PUT /configs?force=true` → 读 `PeakWorkingSet64`（Windows 进程峰值工作集，
不受后续 GC 回落影响）。

| 组 | 形态 | 条目 | reload 耗时 | 峰值 peakWS | peakPriv |
|---|---|---|---|---|---|
| F | 4 表 classical+yaml（现状） | 343,227 | **730 ms** | **121.1 MB** | 153.9 MB |
| G | domain + ipcidr mrs | 343,227 | **30 ms** | **67.9 MB** | 101.6 MB |
| I | 3 表 classical（去掉广告表） | 148,258 | 650 ms | 71.1 MB | 103.9 MB |
| H | 3 表 + `GEOSITE,category-ads-all` | 148,258 | — | 95.3 MB | 128.4 MB |
| D | 基线（1 条规则） | 1 | — | 28.8 MB | 62.6 MB |

单表对照（`agg-ad`，194,969 条，只测首次加载）：

| 形态 | 文件 | gzip/brotli | peakWS |
|---|---|---|---|
| classical + yaml | 7.22 MB | 1.58 MB | 84.1 MB |
| domain + text | 4.24 MB | ≈1.5 MB | 81.2 MB |
| domain + mrs | 1.79 MB | 不可再压 | **43.2 MB** |
| 基线 | 54 B | — | 28.8 MB |

要点：

- **mrs 是唯一同时治 reload 与内存的格式**：reload 快 24 倍、峰值降 44%。
  它靠 mmap + 紧凑编码 + 二分查找，reload 时不需要重新解析文本。
- **`domain` + text 与 classical + yaml 内存几乎一样**，换 behavior 不解决问题。
- **GEOSITE 性价比低**：`GeoSite.dat` 只有 4.08 MB，但 succinct matcher 展开后
  自身约 30 MB，砍掉 19.5 万条省下的空间又赔回去，净降仅 13.7 MB。
- 「启动 → provider ready」这条指标**无区分度**：19.5 万条与 1 条的差距
  被 670–730 ms 的进程启动开销淹没。判断性能要看 reload 耗时与峰值内存。

---

## 4. 为什么 ini 链路拿不到 mrs

MiSub 的 `behavior` / `format` 由私有文件名白名单决定
（`render-clash.js` 的 `ACL4SSR_IPCIDR_PROVIDER_FILES` 只有 5 个 ACL4SSR 文件名，
其余一律 `classical`，`path` 后缀写死 `.yaml`）。`ini-template-parser.js`
的 `ruleset=` 只传策略组与 URL，没有 behavior 参数位。

因此**在「客户端 ← MiSub ← 本仓库 ini」这条链路上，规则集只能是 classical + yaml**。

剩余选项（均需权衡）：

1. **保持现状**：卡顿已由加速通道缓解（下载 50 s → 3 s），但 reload 730 ms
   与 121 MB 峰值不变，崩溃风险仍在。
2. **砍广告表**：峰值降到 71 MB，代价是失去广告拦截；reload 只降 11%，
   因为固定开销（重建监听 / DNS / 策略组）占比大。
3. **脱离 MiSub 出 mrs 配置**：唯一能同时解决两者的路径，但需要自行维护
   节点接入（proxy-providers）与 provider 的 `behavior: domain|ipcidr`、`format: mrs`。
   Clash Verge 的全局扩展脚本也可在客户端侧改写 provider 配置。

---

## 5. 复现方法

```bash
# 1) 准备 mihomo 与规则集，构造仅含 rule-providers 的最小配置
# 2) 启动并等待就绪
curl -s http://127.0.0.1:PORT/providers/rules

# 3) 触发三次 reload 并记录耗时
curl -X PUT -H 'Content-Type: application/json' \
     -d '{"path":"C:/path/to/config.yaml"}' \
     'http://127.0.0.1:PORT/configs?force=true'

# 4) 读峰值（PowerShell）
Get-Process -Id <pid> | Select-Object PeakWorkingSet64, WorkingSet64
```

注意：`PeakWorkingSet64` 必须在进程存活时读取，进程退出后拿不到。
