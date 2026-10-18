#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 n2far2000
/**
 * Loyalsoldier/clash-rules -> MiSub 自定义规则模板（ini）转换器
 *
 * 设计要点（全部基于对 MiSub / mihomo 源码的实测考证，改动前请先读 docs/internals.md）：
 *
 *  1. MiSub 的 ini 解析器只认 [custom] / [proxy group] / [rule] 三个 section。
 *  2. ruleset= 行有两种写法：
 *       ruleset=<策略组>,<远程规则集 URL>      -> 生成 rule-provider
 *       ruleset=<策略组>,[]<TYPE>,<VALUE>      -> 生成内联原生规则
 *  3. MiSub 判定 rule-provider 的 behavior 只靠**文件名白名单**
 *     （render-clash.js 的 ACL4SSR_IPCIDR_PROVIDER_FILES）。
 *     不在白名单里的一律给 classical，而 classical 要求 payload 是**完整规则语法**。
 *     所以我们不能直接把 Loyalsoldier 的 payload（裸域名 / 裸 CIDR）喂过去，
 *     必须自托管一份以 DOMAIN-SUFFIX, / IP-CIDR, 开头的规则集。
 *  4. MiSub 对 .txt/.list 结尾的 URL 会附加 format: text；对 .yaml 不加。
 *     本脚本产出 .yaml，走 mihomo 的 YAML payload 路径。
 *  5. sing-box 渲染器按 URL 是否以 .srs 结尾决定 format（binary/source），
 *     其余一律 source，即要求 **sing-box JSON**。所以 sing-box 档要另一套 URL。
 *  6. 域名语义（mihomo component/trie/domain_set.go）：
 *       '+.example.com' -> 自身 + 所有子域（等价 DOMAIN-SUFFIX）
 *       'example.com'   -> 仅精确匹配（等价 DOMAIN）
 *       '.example.com'  -> 仅子域
 *     转换必须区分这三种，否则会大面积失配。
 *
 * 用法：
 *   node scripts/loyalsoldier2misub.mjs --dist dist --all-presets
 *   node scripts/loyalsoldier2misub.mjs --preset Full --out-dir out
 *   node scripts/loyalsoldier2misub.mjs --offline --dist dist --all-presets --verify
 */

import { mkdir, writeFile, readFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

// ---------------------------------------------------------------- 参数

const argv = process.argv.slice(2);
const arg = (name, dflt) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : dflt;
};
const has = (name) => argv.includes(`--${name}`);

const DIST = arg("dist", null) ? resolve(arg("dist")) : null;
const OUT_DIR = resolve(arg("out-dir", `${ROOT}/output`));
const OUT_FILE = arg("out", null) ? resolve(arg("out")) : null;
const CACHE_DIR = resolve(arg("cache-dir", `${ROOT}/.work/loyalsoldier`));
const OFFLINE = has("offline");
const DO_VERIFY = has("verify") || Boolean(DIST);
const ALL_PRESETS = has("all-presets") || !arg("preset", null);

const GH_OWNER = arg("gh-owner", "n2far2000");
const GH_REPO = arg("gh-repo", "misub-rules");
const GH_REF = arg("gh-ref", "dist");
const CDN_BASE = String(arg("cdn", "https://cdn.jsdelivr.net/gh")).replace(/\/$/, "");
const RULE_BASE = `${CDN_BASE}/${GH_OWNER}/${GH_REPO}@${GH_REF}/rules`;

const SINGLE_PRESET = arg("preset", null);

// ---------------------------------------------------------------- 常量

const UPSTREAM_REPO = "Loyalsoldier/clash-rules";
const UPSTREAM_REF = "release";

/** 上游规则集。kind 决定转换语法的分支。 */
const SOURCES = {
  reject: { file: "reject.txt", kind: "domain", title: "广告与跟踪域名" },
  private: { file: "private.txt", kind: "domain", title: "私有网络域名" },
  icloud: { file: "icloud.txt", kind: "domain", title: "iCloud 域名" },
  apple: { file: "apple.txt", kind: "domain", title: "Apple 直连域名" },
  google: { file: "google.txt", kind: "domain", title: "Google 直连域名" },
  proxy: { file: "proxy.txt", kind: "domain", title: "代理域名" },
  direct: { file: "direct.txt", kind: "domain", title: "直连域名" },
  lancidr: { file: "lancidr.txt", kind: "ip", title: "局域网与保留 IP" },
  cncidr: { file: "cncidr.txt", kind: "ip", title: "中国大陆 IP" },
  telegramcidr: { file: "telegramcidr.txt", kind: "ip", title: "Telegram IP" },
};

/** 仅白名单模式不用的两个表（保留给黑名单模式参考，不产出） */
const UNUSED_SOURCES = {
  gfw: { file: "gfw.txt", kind: "domain" },
  "tld-not-cn": { file: "tld-not-cn.txt", kind: "domain" },
  applications: { file: "applications.txt", kind: "process" },
};

const GROUPS = {
  "🚀 节点选择": ["select", "[]⚡ 自动选择", "[]DIRECT", "[]REJECT", ".*"],
  "⚡ 自动选择": ["url-test", ".*", "http://www.gstatic.com/generate_204", "300,,50"],
  "🛑 广告拦截": ["select", "[]REJECT", "[]DIRECT"],
  "🏠 私有网络": ["select", "[]DIRECT", "[]REJECT"],
  "🍎 苹果服务": ["select", "[]DIRECT", "[]🚀 节点选择"],
  "☁️ iCloud": ["select", "[]DIRECT", "[]🚀 节点选择"],
  "🔍 Google": ["select", "[]🚀 节点选择", "[]DIRECT"],
  "🎯 全球直连": ["select", "[]DIRECT", "[]🚀 节点选择"],
  "📲 Telegram": ["select", "[]🚀 节点选择", "[]DIRECT"],
  "🐟 漏网之鱼": ["select", "[]🚀 节点选择", "[]⚡ 自动选择", "[]DIRECT"],
};

const CORE_GROUPS = ["🚀 节点选择", "⚡ 自动选择"];

/** 控制面板自身走直连，官方推荐配置里也带这两条 */
const CONSOLE_RULES = [
  { inline: ["DOMAIN", "clash.razord.top"], policy: "🎯 全球直连" },
  { inline: ["DOMAIN", "yacd.haishan.me"], policy: "🎯 全球直连" },
];

const PRESETS = {
  Full: {
    title: "完整白名单",
    desc: "覆盖官方推荐白名单的全部 10 张表，含 iCloud / Apple / Google / Telegram 细分",
    groups: [
      ...CORE_GROUPS,
      "🛑 广告拦截",
      "🏠 私有网络",
      "☁️ iCloud",
      "🍎 苹果服务",
      "🔍 Google",
      "🎯 全球直连",
      "📲 Telegram",
      "🐟 漏网之鱼",
    ],
    rules: [
      ...CONSOLE_RULES,
      { set: "private", policy: "🏠 私有网络" },
      { set: "reject", policy: "🛑 广告拦截" },
      { set: "icloud", policy: "☁️ iCloud" },
      { set: "apple", policy: "🍎 苹果服务" },
      { set: "google", policy: "🔍 Google" },
      { set: "proxy", policy: "🚀 节点选择" },
      { set: "direct", policy: "🎯 全球直连" },
      { set: "lancidr", policy: "🏠 私有网络" },
      { set: "cncidr", policy: "🎯 全球直连" },
      { set: "telegramcidr", policy: "📲 Telegram" },
      { inline: ["GEOIP", "CN"], policy: "🎯 全球直连" },
      { final: true, policy: "🐟 漏网之鱼" },
    ],
  },
  Standard: {
    title: "标准白名单",
    desc: "去掉 iCloud / Apple / Google / Telegram 细分，保留两张 IP 表",
    groups: [...CORE_GROUPS, "🛑 广告拦截", "🏠 私有网络", "🎯 全球直连", "🐟 漏网之鱼"],
    rules: [
      ...CONSOLE_RULES,
      { set: "private", policy: "🏠 私有网络" },
      { set: "reject", policy: "🛑 广告拦截" },
      { set: "proxy", policy: "🚀 节点选择" },
      { set: "direct", policy: "🎯 全球直连" },
      { set: "lancidr", policy: "🏠 私有网络" },
      { set: "cncidr", policy: "🎯 全球直连" },
      { inline: ["GEOIP", "CN"], policy: "🎯 全球直连" },
      { final: true, policy: "🐟 漏网之鱼" },
    ],
  },
  Minimal: {
    title: "极简白名单",
    desc: "只保留 4 张域名表，不含任何 IP 表，国内直连全靠 GEOIP,CN 兜底",
    groups: [...CORE_GROUPS, "🛑 广告拦截", "🏠 私有网络", "🎯 全球直连", "🐟 漏网之鱼"],
    rules: [
      ...CONSOLE_RULES,
      { set: "private", policy: "🏠 私有网络" },
      { set: "reject", policy: "🛑 广告拦截" },
      { set: "proxy", policy: "🚀 节点选择" },
      { set: "direct", policy: "🎯 全球直连" },
      { inline: ["GEOIP", "CN"], policy: "🎯 全球直连" },
      { final: true, policy: "🐟 漏网之鱼" },
    ],
  },
};

/** 历史文件名 -> 新文件名。两条路径都要产出，保证旧订阅链接不失效。 */
const LEGACY_PREFIX = "SubBoost";
const NEW_PREFIX = "Loyalsoldier";

// ---------------------------------------------------------------- 工具

const log = (msg) => console.log(msg);
const warn = (msg) => console.warn(`[WARN] ${msg}`);
const fatal = (msg) => {
  console.error(`[ERROR] ${msg}`);
  process.exit(1);
};

const KIB = (n) => `${(n / 1024).toFixed(1)} KiB`;
const MIB = (n) => `${(n / 1024 / 1024).toFixed(2)} MiB`;

const DOMAIN_RE = /^[a-z0-9]([a-z0-9_-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9_-]*[a-z0-9])?)*$/i;
const CIDR4_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\/(\d{1,2})$/;
const CIDR6_RE = /^[0-9a-f:]+\/\d{1,3}$/i;

async function fetchText(url, ms = 60000) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), ms);
  try {
    const res = await fetch(url, { signal: ctl.signal, redirect: "follow" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

const MIRRORS = ["cdn.jsdelivr.net/gh", "fastly.jsdelivr.net/gh", "testingcf.jsdelivr.net/gh", "gcore.jsdelivr.net/gh"];

function upstreamUrls(file) {
  return [
    ...MIRRORS.map((m) => `https://${m}/${UPSTREAM_REPO}@${UPSTREAM_REF}/${file}`),
    `https://raw.githubusercontent.com/${UPSTREAM_REPO}/${UPSTREAM_REF}/${file}`,
  ];
}

async function loadSource(name, spec) {
  const cachePath = join(CACHE_DIR, spec.file);
  if (OFFLINE) {
    if (!existsSync(cachePath)) fatal(`--offline 但缺少缓存: ${cachePath}`);
    return await readFile(cachePath, "utf8");
  }
  let lastErr;
  for (const url of upstreamUrls(spec.file)) {
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const text = await fetchText(url);
        if (!text || text.length < 16) throw new Error("响应过短");
        await mkdir(CACHE_DIR, { recursive: true });
        await writeFile(cachePath, text, "utf8");
        log(`  <- ${name}  ${KIB(Buffer.byteLength(text))}  (${new URL(url).host})`);
        return text;
      } catch (e) {
        lastErr = e;
      }
    }
  }
  if (existsSync(cachePath)) {
    warn(`${name} 全部源失败（${lastErr?.message}），回退本地缓存`);
    return await readFile(cachePath, "utf8");
  }
  fatal(`${name} 无法获取: ${lastErr?.message}`);
}

// ---------------------------------------------------------------- 解析

/** 解析 Loyalsoldier 的 YAML payload 文件，返回原始条目数组 */
function parsePayload(text) {
  const out = [];
  const lines = String(text).split(/\r?\n/);
  for (const raw of lines) {
    const t = raw.trim();
    if (!t || t === "payload:") continue;
    const m = t.match(/^-\s*(.*)$/);
    if (!m) continue;
    let v = m[1].trim();
    if ((v.startsWith("'") && v.endsWith("'")) || (v.startsWith('"') && v.endsWith('"'))) {
      v = v.slice(1, -1);
    }
    if (v) out.push(v);
  }
  return out;
}

/**
 * 把域名条目归一成 { mode: 'suffix' | 'exact', domain }
 *   上游 '+.x'  -> 自身+子域，等价 DOMAIN-SUFFIX
 *   上游 '.x'   -> 仅子域，本仓库按 DOMAIN-SUFFIX 处理（略宽，实测该形态出现 0 次）
 *   上游 'x'    -> 仅精确匹配，等价 DOMAIN
 */
function normalizeDomain(raw) {
  const t = String(raw).trim();
  const lower = t.toLowerCase();
  const plus = lower.startsWith("+.");
  const dot = !plus && lower.startsWith(".");
  const domain = lower.replace(/^\+\./, "").replace(/^\./, "");
  if (!domain || !DOMAIN_RE.test(domain)) return null;
  return { mode: plus || dot ? "suffix" : "exact", domain };
}

function normalizeCidr(raw) {
  const s = raw.trim().toLowerCase();
  const m4 = s.match(CIDR4_RE);
  if (m4) {
    const octets = [m4[1], m4[2], m4[3], m4[4]].map(Number);
    if (octets.some((o) => o > 255)) return null;
    if (Number(m4[5]) > 32) return null;
    return { family: 4, cidr: s };
  }
  if (s.includes(":") && CIDR6_RE.test(s)) return { family: 6, cidr: s };
  return null;
}

/** 归一化整张表，返回 { suffix:Set, exact:Set, v4:[], v6:[], skipped } */
function normalizeSet(name, rawEntries, kind) {
  const suffix = new Set();
  const exact = new Set();
  const v4 = new Set();
  const v6 = new Set();
  let skipped = 0;

  for (const raw of rawEntries) {
    if (kind === "domain") {
      const d = normalizeDomain(raw);
      if (!d) {
        skipped++;
        continue;
      }
      (d.mode === "suffix" ? suffix : exact).add(d.domain);
    } else if (kind === "ip") {
      const c = normalizeCidr(raw);
      if (!c) {
        skipped++;
        continue;
      }
      (c.family === 4 ? v4 : v6).add(c.cidr);
    }
  }
  if (skipped > 0) warn(`${name}: 跳过 ${skipped} 条无法识别的条目`);

  return {
    name,
    kind,
    suffix: [...suffix],
    exact: [...exact],
    v4: [...v4],
    v6: [...v6],
    count: suffix.size + exact.size + v4.size + v6.size,
    raw: rawEntries.length,
  };
}

// ---------------------------------------------------------------- 产物

function toClashYaml(set, upstreamCommit) {
  const lines = [
    `# ${SOURCES[set.name].title} — Loyalsoldier/clash-rules @ ${UPSTREAM_REF}`,
    `# 由 loyalsoldier2misub.mjs 生成，共 ${set.count} 条；请勿手改`,
    `# 上游 commit: ${upstreamCommit}`,
    "payload:",
  ];
  for (const d of set.suffix) lines.push(`  - DOMAIN-SUFFIX,${d}`);
  for (const d of set.exact) lines.push(`  - DOMAIN,${d}`);
  for (const c of set.v4) lines.push(`  - IP-CIDR,${c}`);
  for (const c of set.v6) lines.push(`  - IP-CIDR6,${c}`);
  lines.push("");
  return lines.join("\n");
}

function toSingboxJson(set) {
  const rule = {};
  if (set.suffix.length) rule.domain_suffix = set.suffix;
  if (set.exact.length) rule.domain = set.exact;
  if (set.v4.length || set.v6.length) rule.ip_cidr = [...set.v4, ...set.v6];
  const doc = { version: 3, rules: [rule] };
  return JSON.stringify(doc);
}

// ---------------------------------------------------------------- ini

function ruleLinesForPreset(preset, ruleBase) {
  const lines = [];
  for (const r of preset.rules) {
    if (r.final) {
      lines.push({ text: `ruleset=${r.policy},[]FINAL`, policy: r.policy, kind: "final" });
    } else if (r.inline) {
      lines.push({
        text: `ruleset=${r.policy},[]${r.inline.join(",")}`,
        policy: r.policy,
        kind: "inline",
        type: r.inline[0],
        value: r.inline[1] || "",
      });
    } else if (r.set) {
      lines.push({
        text: `ruleset=${r.policy},${ruleBase}/${r.set}.__EXT__`,
        policy: r.policy,
        kind: "remote",
        set: r.set,
      });
    }
  }
  return lines;
}

function renderIni({ presetName, preset, ruleBase, ext, upstreamCommit, builtAt, ghOwner, ghRepo, ghRef }) {
  const ruleLines = ruleLinesForPreset(preset, ruleBase);
  const L = [];
  const pad = "=".repeat(60);

  L.push(`# ${pad}`);
  L.push(`# ${preset.title} · Loyalsoldier 白名单模式 -> MiSub 规则模板 (ini)`);
  L.push(`# 由 loyalsoldier2misub.mjs 自动生成于 ${builtAt}`);
  L.push(`# 上游: github.com/${UPSTREAM_REPO} @ ${UPSTREAM_REF} (${upstreamCommit.slice(0, 7)})`);
  L.push(`# 目标客户端格式: ${ext === "yaml" ? "Clash / Mihomo" : "sing-box"}`);
  L.push(`#`);
  L.push(`# 【MiSub 识别格式要点 - 改动前务必先看 docs/internals.md】`);
  L.push(`#   1. MiSub 只识别 [custom] / [proxy group] / [rule] 三个 section，其它一律忽略。`);
  L.push(`#   2. 规则统一写成 ruleset= 行以完整保留顺序；写进 [rule] 会被 MiSub 提到所有`);
  L.push(`#      ruleset= 之前，顺序被打乱。`);
  L.push(`#   3. ruleset=<策略组>,<URL> 生成 rule-provider；ruleset=<策略组>,[]TYPE,VALUE`);
  L.push(`#      生成内联原生规则（[]FINAL 会渲染成 MATCH）。`);
  L.push(`#   4. custom_proxy_group= 的成员必须真实存在，否则 MiSub 的`);
  L.push(`#      pruneEmptyGroups 会剪掉空组，并连带删除指向它的规则。`);
  L.push(`#   5. 成员语法: []名称 = 引用其它组 / .* = 全部节点 / (正则) = 按正则筛选；`);
  L.push(`#      url-test 末尾是 间隔,,容差(秒)。`);
  L.push(`#   6. MiSub 判断 rule-provider 的 behavior 只靠文件名白名单，不在白名单里`);
  L.push(`#      一律 classical，因此本文件的规则集必须是完整规则语法（DOMAIN-SUFFIX,x）。`);
  L.push(`#      直接引用上游裸域名 payload 会导致客户端规则解析失败。`);
  L.push(`#   7. 规则顺序严格复刻 Loyalsoldier README 的「白名单模式」推荐顺序。`);
  L.push(`# ${pad}`);
  L.push("");
  L.push("[custom]");
  L.push("");

  let lastPolicy = null;
  const order = [];
  for (const rl of ruleLines) {
    if (rl.policy !== lastPolicy) {
      order.push("");
      const label = documentTitleFor(rl);
      order.push(`# ---- ${rl.policy}${label ? ` · ${label}` : ""} ----`);
      lastPolicy = rl.policy;
    }
    order.push(rl.text.replace("__EXT__", ext));
  }
  L.push(...order);

  L.push("");
  L.push("# ==================== 策略组 ====================");
  const BT = String.fromCharCode(96); // ACL4SSR 用反引号分隔策略组字段
  for (const name of preset.groups) {
    const def = GROUPS[name];
    if (!def) fatal(`未定义策略组: ${name}`);
    L.push("custom_proxy_group=" + [name, ...def].join(BT));
  }
  L.push("");

  return L.join("\n");
}

function documentTitleFor(ruleLine) {
  if (ruleLine.kind === "final") return "白名单兜底：未命中即走代理";
  if (ruleLine.kind === "inline") return `内联 ${ruleLine.type},${ruleLine.value}`;
  if (ruleLine.kind === "remote") return SOURCES[ruleLine.set]?.title || "";
  return "";
}

// ---------------------------------------------------------------- 校验

/**
 * 复刻 MiSub ini 解析的最小实现，用于本地回归。
 * 关键点（对齐 ini-template-parser.js）：ruleset= 与 custom_proxy_group= 都必须出现在
 * [custom] 段内；[proxy group] 段用的是另一套 `=`,`,` 语法，写进去反而会丢掉反引号语义。
 */
function parseIniForVerify(text) {
  const lines = String(text).split(/\r?\n/);
  let section = "custom";
  const rules = [];
  const groups = [];
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith("#") || line.startsWith(";")) continue;
    const sm = line.match(/^\[(.+)]$/);
    if (sm) {
      section = sm[1].trim().toLowerCase();
      continue;
    }
    if (section !== "custom") continue;

    if (/^ruleset=/i.test(line)) {
      const body = line.replace(/^ruleset=/i, "");
      const parts = body.split(",").map((p) => p.trim());
      const policy = parts[0];
      const rest = parts.slice(1).join(",");
      if (rest.startsWith("[]")) {
        const iv = rest.slice(2).split(",").map((p) => p.trim()).filter(Boolean);
        rules.push({ kind: "inline", type: (iv[0] || "").toLowerCase(), value: iv[1] || "", policy });
      } else {
        rules.push({ kind: "remote", url: rest, policy });
      }
      continue;
    }

    if (/^custom_proxy_group=/i.test(line)) {
      const body = line.replace(/^custom_proxy_group=/i, "");
      const parts = body.split("`").map((p) => p.trim()).filter(Boolean);
      if (parts.length < 2) continue;
      const [name, type, ...rest] = parts;
      const members = [];
      const filters = [];
      const options = {};
      for (const part of rest) {
        if (part.startsWith("[]")) {
          members.push(part.slice(2));
          continue;
        }
        if (/^https?:\/\//i.test(part)) {
          options.url = part;
          continue;
        }
        if (/^\d+(?:,\s*\d*)*$/.test(part)) continue;
        if (part === ".*" || (part.startsWith("(") && part.endsWith(")"))) {
          filters.push(part === ".*" ? ".*" : part.slice(1, -1));
          continue;
        }
        memberOrFilter(part, members, filters);
      }
      groups.push({ name, type, members, filters, options });
    }
  }
  return { rules, groups };
}

function memberOrFilter(part, members, filters) {
  if (!part || part.includes("=")) return;
  if (/[*+[\]?|]/.test(part)) filters.push(part);
  else members.push(part);
}

function verifyIni(inLabel, iniText, sets, presetName, ruleBase) {
  const { rules, groups } = parseIniForVerify(iniText);
  const problems = [];

  const groupNames = new Set(groups.map((g) => g.name));

  // 1. 策略组自洽
  const seen = new Set();
  for (const g of groups) {
    if (seen.has(g.name)) problems.push(`策略组重名: ${g.name}`);
    seen.add(g.name);
    if (g.members.length === 0 && g.filters.length === 0) {
      problems.push(`策略组既无成员也无过滤器（会被 MiSub 剪掉）: ${g.name}`);
    }
    for (const m of g.members) {
      if (!groupNames.has(m) && !["DIRECT", "REJECT", "REJECT-DROP"].includes(m)) {
        problems.push(`策略组 ${g.name} 引用了不存在的成员: ${m}`);
      }
    }
    if (/url-test|fallback|load-balance/i.test(g.type) && !g.options.url) {
      problems.push(`测速类策略组缺少健康检查 URL: ${g.name}`);
    }
  }

  // 2. 规则指向的策略组必须存在
  for (const r of rules) {
    if (!groupNames.has(r.policy)) problems.push(`规则指向不存在的策略组: ${r.policy}`);
  }

  // 3. FINAL 必须存在且位于最后
  const last = rules[rules.length - 1];
  if (!last || last.type !== "final") problems.push("最后一条规则不是 []FINAL");
  const finals = rules.filter((r) => r.type === "final");
  if (finals.length !== 1) problems.push(`[]FINAL 出现 ${finals.length} 次（应为 1）`);

  // 4. 远程规则集 URL 必须带正确扩展名，且都在 sets 里出现过
  for (const r of rules) {
    if (r.kind !== "remote") continue;
    const m = r.url.match(new RegExp(`^${ruleBase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/([a-z0-9-]+)\\.(yaml|json)$`, "i"));
    if (!m) problems.push(`规则集 URL 形态异常: ${r.url}`);
    else if (!sets[m[1]]) problems.push(`规则集 URL 指向未生成的集合: ${m[1]}`);
  }

  // 5. 路由顺序模拟：各表的首条条目应当命中自己的策略组
  const ordered = [];
  for (const r of rules) {
    if (r.kind === "remote") {
      const name = r.url.split("/").pop().replace(/\.(yaml|json)$/i, "");
      ordered.push({ policy: r.policy, set: sets[name] });
    } else if (r.type && r.type !== "final" && r.type !== "geoip") {
      ordered.push({ policy: r.policy, exactInline: r.value.toLowerCase() });
    }
  }

  const routeOf = (host) => {
    for (const o of ordered) {
      if (o.exactInline) {
        if (host === o.exactInline) return o.policy;
        continue;
      }
      const s = o.set;
      if (!s || s.kind !== "domain") continue;
      if (s.exactSet.has(host)) return o.policy;
      let h = host;
      while (true) {
        if (s.suffixSet.has(h)) return o.policy;
        const i = h.indexOf(".");
        if (i < 0) break;
        h = h.slice(i + 1);
      }
    }
    return null;
  };

  const samples = [];
  for (const r of rules) {
    if (r.kind !== "remote") continue;
    const name = r.url.split("/").pop().replace(/\.(yaml|json)$/i, "");
    const s = sets[name];
    if (!s || s.kind !== "domain") continue;
    const probe = s.suffix[0] || s.exact[0];
    if (!probe) continue;
    const host = `probe.${probe}`;
    const got = routeOf(host);
    samples.push({ set: name, host, expect: r.policy, got });
    if (got !== r.policy) {
      problems.push(`路由顺序异常: ${name} 的样例 ${host} 命中 ${got}，期望 ${r.policy}`);
    }
  }

  // 6. 未命中任何表时应落到 FINAL 之后的兜底组（此处仅确认 FINAL 存在，见 3）

  const tag = `${presetName}${inLabel ? ` (${inLabel})` : ""}`;
  if (problems.length === 0) {
    log(
      `  [PASS] ${tag}: ${rules.length} 条规则 / ${groups.length} 个策略组 / ` +
        `路由抽样 ${samples.length} 项全部命中预期`
    );
  } else {
    log(`  [FAIL] ${tag}`);
    for (const p of problems) log(`         · ${p}`);
  }
  return problems.length === 0;
}

// ---------------------------------------------------------------- 主流程

async function main() {
  log("=== Loyalsoldier -> MiSub 转换 ===");
  log(`输出: ${DIST ? DIST : OUT_DIR}${OFFLINE ? "  [离线]" : ""}`);
  if (!OFFLINE) log("拉取上游规则集:");

  const rawTexts = {};
  for (const [name, spec] of Object.entries(SOURCES)) {
    rawTexts[name] = await loadSource(name, spec);
  }

  let upstreamCommit = "unknown";
  if (!OFFLINE) {
    try {
      const branch = JSON.parse(
        await fetchText(`https://api.github.com/repos/${UPSTREAM_REPO}/branches/${UPSTREAM_REF}`, 20000)
      );
      upstreamCommit = branch?.commit?.sha || "unknown";
    } catch {
      warn("无法获取上游 commit，退化为 unknown");
    }
  }

  log("");
  log("归一化:");
  const sets = {};
  for (const [name, text] of Object.entries(rawTexts)) {
    const spec = SOURCES[name];
    const raw = parsePayload(text);
    const s = normalizeSet(name, raw, spec.kind);
    sets[name] = s;
    // 供路由模拟使用的快速索引
    s.suffixSet = new Set(s.suffix);
    s.exactSet = new Set(s.exact);
    log(
      `  ${name.padEnd(14)} ${String(s.count).padStart(7)} 条` +
        (spec.kind === "domain"
          ? `  (后缀 ${s.suffix.length} / 精确 ${s.exact.length})`
          : `  (v4 ${s.v4.length} / v6 ${s.v6.length})`) +
        (s.count === 0 ? "   <-- 空表！" : "")
    );
  }

  const emptySets = Object.values(sets).filter((s) => s.count === 0);
  if (emptySets.length) fatal(`存在空规则集: ${emptySets.map((s) => s.name).join(", ")}`);

  const builtAt = new Date().toISOString();
  const presetNames = ALL_PRESETS ? Object.keys(PRESETS) : [SINGLE_PRESET || "Full"];
  for (const p of presetNames) if (!PRESETS[p]) fatal(`未知预设: ${p}`);

  const outRoot = DIST || OUT_DIR;
  const results = [];
  let ok = true;

  for (const pName of presetNames) {
    const preset = PRESETS[pName];
    for (const ext of ["yaml", "json"]) {
      const label = ext === "yaml" ? "clash" : "singbox";
      const ruleBase = `${RULE_BASE}/${ext === "yaml" ? "clash" : "singbox"}`;
      const ini = renderIni({
        presetName: pName,
        preset,
        ruleBase,
        ext,
        upstreamCommit,
        builtAt,
        ghOwner: GH_OWNER,
        ghRepo: GH_REPO,
        ghRef: GH_REF,
      });
      results.push({ pName, ext, label, ini });
    }
  }

  // 写产物
  const write = async (rel, content) => {
    const p = join(outRoot, rel);
    await mkdir(dirname(p), { recursive: true });
    await writeFile(p, content, "utf8");
    return { rel, bytes: Buffer.byteLength(content) };
  };

  const written = [];

  if (DIST) {
    log("");
    log("写出规则集:");
    for (const [name, s] of Object.entries(sets)) {
      const y = await write(`rules/clash/${name}.yaml`, toClashYaml(s, upstreamCommit));
      const j = await write(`rules/singbox/${name}.json`, toSingboxJson(s));
      written.push(y, j);
      log(`  ${name.padEnd(14)} clash ${MIB(y.bytes).padStart(10)}   singbox ${MIB(j.bytes).padStart(10)}`);
    }
  }

  log("");
  log("写出 ini:");
  for (const r of results) {
    // 通用目录：misub/（clash 形态）与 misub-remote/（显式格式）
    const targets = [];
    if (r.ext === "yaml") {
      targets.push(`misub/${NEW_PREFIX}_${r.pName}_MiSub.ini`);
      targets.push(`misub/${LEGACY_PREFIX}_${r.pName}_MiSub.ini`);
    }
    targets.push(`misub-remote/${NEW_PREFIX}_${r.pName}_MiSub_${r.label}.ini`);
    targets.push(`misub-remote/${LEGACY_PREFIX}_${r.pName}_MiSub_${r.label}.ini`);

    for (const rel of targets) {
      if (DIST) {
        written.push(await write(rel, r.ini));
      } else {
        written.push({ rel, bytes: Buffer.byteLength(r.ini) });
      }
    }

    if (DO_VERIFY) {
      ok = verifyIni(`remote-${r.label}`, r.ini, sets, r.pName, `${RULE_BASE}/${r.ext === "yaml" ? "clash" : "singbox"}`) && ok;
    }
  }

  for (const rel of [...new Set(written.map((w) => w.rel))]) {
    const w = written.find((x) => x.rel === rel);
    log(`  ${rel.padEnd(52)} ${KIB(w.bytes).padStart(11)}`);
  }

  // 单文件输出（bat 用）
  if (OUT_FILE) {
    const target = results.find((r) => r.ext === "yaml") || results[0];
    await mkdir(dirname(OUT_FILE), { recursive: true });
    await writeFile(OUT_FILE, target.ini, "utf8");
    log("");
    log(`已写出单文件: ${OUT_FILE}`);
  }

  if (!DIST && !OUT_FILE) {
    for (const r of results) {
      const p = join(OUT_DIR, `misub-remote/${NEW_PREFIX}_${r.pName}_MiSub_${r.label}.ini`);
      await mkdir(dirname(p), { recursive: true });
      await writeFile(p, r.ini, "utf8");
    }
    log("");
    log(`已写出到 ${OUT_DIR}`);
  }

  // manifest / upstream
  if (DIST) {
    const manifest = {
      generatedAt: builtAt,
      generator: "loyalsoldier2misub.mjs",
      mode: "whitelist",
      source: { repo: UPSTREAM_REPO, ref: UPSTREAM_REF, commit: upstreamCommit },
      ruleBase: RULE_BASE,
      presets: Object.fromEntries(
        presetNames.map((p) => [
          p,
          {
            title: PRESETS[p].title,
            desc: PRESETS[p].desc,
            sets: PRESETS[p].rules.filter((r) => r.set).map((r) => r.set),
            entries: PRESETS[p].rules
              .filter((r) => r.set)
              .reduce((n, r) => n + (sets[r.set]?.count || 0), 0),
            files: {
              generic: `misub/${NEW_PREFIX}_${p}_MiSub.ini`,
              clash: `misub-remote/${NEW_PREFIX}_${p}_MiSub_clash.ini`,
              singbox: `misub-remote/${NEW_PREFIX}_${p}_MiSub_singbox.ini`,
              legacy: {
                generic: `misub/${LEGACY_PREFIX}_${p}_MiSub.ini`,
                clash: `misub-remote/${LEGACY_PREFIX}_${p}_MiSub_clash.ini`,
                singbox: `misub-remote/${LEGACY_PREFIX}_${p}_MiSub_singbox.ini`,
              },
            },
          },
        ])
      ),
      ruleSets: Object.fromEntries(
        Object.entries(sets).map(([n, s]) => [
          n,
          {
            title: SOURCES[n].title,
            kind: s.kind,
            count: s.count,
            clash: `rules/clash/${n}.yaml`,
            singbox: `rules/singbox/${n}.json`,
          },
        ])
      ),
    };
    written.push(await write("manifest.json", JSON.stringify(manifest, null, 2) + "\n"));
    written.push(
      await write(
        "upstream.json",
        JSON.stringify({ repo: UPSTREAM_REPO, ref: UPSTREAM_REF, commit: upstreamCommit, fetchedAt: builtAt }, null, 2) + "\n"
      )
    );
    const total = written.reduce((n, w) => n + w.bytes, 0);
    log("");
    log(`产物合计: ${written.length} 个文件 / ${MIB(total)}`);
  }

  log("");
  if (DO_VERIFY) {
    log(ok ? "=== 本地校验全部通过 ===" : "=== 本地校验存在失败项 ===");
    if (!ok) process.exit(1);
  }
}

main().catch((e) => fatal(e.stack || e.message));
