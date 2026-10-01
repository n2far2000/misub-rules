#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 n2far2000 <n2far2000@users.noreply.github.com>
/**
 * subboost2misub.mjs
 *
 * 把 SubBoost 的预设分流规则（minimal / standard / full）转换为 MiSub 可用的产物。
 *
 * 两种运行模式：
 *   1) 本地模式（默认）：只输出一个 MiSub 自定义规则模板 ini
 *        node subboost2misub.mjs --out out.ini
 *   2) 产物模式 --dist：输出完整 dist 目录，供 GitHub Actions + jsDelivr 分发
 *        node subboost2misub.mjs --dist dist --all-presets \
 *          --gh-owner <owner> --gh-repo <repo> --gh-ref dist --verify
 *
 * dist 目录结构：
 *   dist/misub/SubBoost_<Preset>_MiSub.ini          内联 GEOSITE 模板（Clash 与 sing-box 双端正确）
 *   dist/misub-remote/..._clash.ini                 引用远程规则集（Clash 版）
 *   dist/misub-remote/..._singbox.ini               引用远程规则集（sing-box 版）
 *   dist/rules/clash/sb-<run>.yaml                  classical 规则集（YAML payload）
 *   dist/rules/singbox/sb-<run>.json                sing-box source 规则集（JSON）
 *   dist/manifest.json                              版本 / 上游 sha / 文件 sha256
 *   dist/upstream.json                              上游指纹，用于判断「结构是否变化」
 *
 * ── 为什么是这两套格式（源码级依据，勿凭记忆修改）────────────────────
 * MiSub 把 ini 里的 `ruleset=组名,<http URL>` 当远程规则集，但两个内核要求互斥：
 *   · render-clash.js  → rule-providers，behavior 由「文件名」决定：
 *       文件名 ∈ {amazonip, chinacompanyip, chinaip, chinaipv6, netflixip} ? ipcidr : classical
 *       即除少数特例外一律 classical，没有 domain 行为 → 必须输出完整规则行
 *       因此本脚本用 sb- 前缀命名，确保永远命中 classical
 *   · render-singbox.js → rule_set，format 只看扩展名：.srs ? binary : source
 *       sing-box 的 source 格式只支持 JSON（{version:1, rules:[...]}），YAML 不行
 * 结论：一个 URL 不可能同时喂饱两个内核 → 远程规则集出两套文件、两份 ini。
 * 内联 []GEOSITE,x 则双端都正确（Clash 原生规则 / sing-box 自动映射 SagerNet .srs），
 * 所以内联版仍然是主推产物。
 *
 * ── 聚合策略 ────────────────────────────────────────────────────
 * 按「连续且同策略组」的规则合成一个规则集文件（run），而不是每条规则一个文件，
 * 也绝不按组名跨段合并 —— SubBoost 会把 apple-tvplus 插到 apple 位置，
 * 导致「📺 欧美流媒体」在同一份配置里出现两段，跨段合并会破坏命中顺序。
 */

import { readFile, writeFile, mkdir, access, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------- 参数

const argv = process.argv.slice(2);
const arg = (name, dflt) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : dflt;
};
const has = (name) => argv.includes(`--${name}`);

const PRESETS = has("all-presets")
  ? ["full", "standard", "minimal"]
  : [String(arg("preset", "full")).toLowerCase()];
for (const p of PRESETS) {
  if (!["minimal", "standard", "full"].includes(p)) {
    fatal(`--preset 只支持 minimal | standard | full，收到: ${p}`);
  }
}

// 仓库根目录（脚本位于 scripts/ 下），本地模式的默认输出与缓存都放在这里
const ROOT = resolve(__dirname, "..");

const OUT = resolve(arg("out", `${ROOT}/SubBoost_${cap(PRESETS[0])}_MiSub.ini`));
const DIST = arg("dist", null) ? resolve(arg("dist")) : null;
const CACHE_DIR = resolve(arg("cache-dir", `${ROOT}/.work/subboost`));
const GEO_CACHE = resolve(arg("geo-cache", `${ROOT}/.work/geo`));
// geodata 本地缓存有效期（分钟）；0 表示禁用缓存、每次都重新下载
const GEO_TTL_MINUTES = Number(arg("geo-cache-ttl", "1440"));
const OFFLINE = has("offline");
const DO_VERIFY = has("verify") || Boolean(DIST);
const DO_GEODATA = has("verify-geodata");
const ALL_NODES = has("all-nodes");
const DO_DIFF = has("diff");

const GH_OWNER = arg("gh-owner", "");
const GH_REPO = arg("gh-repo", "");
const GH_REF = arg("gh-ref", "dist");
const RULE_BASE_URL = arg(
  "rule-base-url",
  GH_OWNER && GH_REPO ? `https://cdn.jsdelivr.net/gh/${GH_OWNER}/${GH_REPO}@${GH_REF}` : ""
);
const RULE_FORMATS = String(arg("rules", "clash,singbox"))
  .split(",")
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);

const PRESET_META = {
  minimal: { name: "精简版", slug: "Minimal" },
  standard: { name: "标准版", slug: "Standard" },
  full: { name: "完整版", slug: "Full" },
};

function cap(s) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
function fatal(msg) {
  console.error(`[FATAL] ${msg}`);
  process.exit(1);
}
function sha256(buf) {
  return createHash("sha256").update(buf).digest("hex");
}

const SOURCES = [
  { key: "modules", path: "packages/core/src/generator/proxy-group-modules.ts" },
  { key: "rules", path: "packages/core/src/generator/rules.ts" },
  { key: "groups", path: "packages/core/src/generator/proxy-groups.ts" },
  { key: "defaults", path: "packages/core/src/config/defaults.ts" },
];

const BASES = [
  (p) => `https://cdn.jsdelivr.net/gh/SubBoost/subboost@main/${p}`,
  (p) => `https://raw.githubusercontent.com/SubBoost/subboost/main/${p}`,
];

// ---------------------------------------------------------------- 抓取

async function fetchText(url, ms = 30000) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), ms);
  try {
    const res = await fetch(url, { signal: ctl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

async function fetchWithFallbacks(urls, label, attempts = 2) {
  let lastErr = null;
  for (const url of urls) {
    for (let i = 0; i < attempts; i++) {
      try {
        return await fetchText(url);
      } catch (err) {
        lastErr = err;
      }
    }
  }
  throw new Error(`${label} 抓取失败: ${lastErr?.message}`);
}

async function loadSources() {
  await mkdir(CACHE_DIR, { recursive: true });
  const out = {};
  for (const src of SOURCES) {
    const cacheFile = `${CACHE_DIR}/${src.key}.ts`;
    let text = null;
    let from = "";
    if (!OFFLINE) {
      try {
        text = await fetchWithFallbacks(
          BASES.map((b) => b(src.path)),
          src.path
        );
        from = "network";
        await writeFile(cacheFile, text, "utf8");
      } catch (err) {
        console.warn(`[WARN] ${err.message}`);
      }
    }
    if (text === null) {
      try {
        await access(cacheFile);
        text = await readFile(cacheFile, "utf8");
        from = "local-cache";
      } catch {
        fatal(`无法获取 ${src.path}（网络失败且无本地缓存）`);
      }
    }
    out[src.key] = text;
    console.log(`  · ${src.key.padEnd(8)} ${String(text.length).padStart(6)} bytes  <- ${from}`);
  }
  return out;
}

async function latestCommitSha() {
  if (OFFLINE) return null;
  try {
    const res = await fetch("https://api.github.com/repos/SubBoost/subboost/commits?per_page=1", {
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) return null;
    const json = await res.json();
    return json?.[0]?.sha?.slice(0, 7) || null;
  } catch {
    return null;
  }
}

/** 拉取 MetaCubeX 的 geosite/geoip 明文列表（带 TTL 本地缓存，避免校验阶段重复下载） */
async function fetchGeoList(kind, name) {
  const dir = join(GEO_CACHE, kind);
  await mkdir(dir, { recursive: true });
  const file = join(dir, `${name}.list`);

  // 命中未过期缓存就直接用；CI 首次运行没有缓存，会走网络
  if (!OFFLINE && GEO_TTL_MINUTES > 0) {
    try {
      const st = await stat(file);
      if (Date.now() - st.mtimeMs < GEO_TTL_MINUTES * 60_000) {
        const cached = await readFile(file, "utf8");
        if (cached.trim()) return cached;
      }
    } catch {
      /* 无缓存则继续走网络 */
    }
  }

  if (!OFFLINE) {
    const urls = [
      `https://raw.githubusercontent.com/MetaCubeX/meta-rules-dat/meta/geo/${kind}/${name}.list`,
      `https://cdn.jsdelivr.net/gh/MetaCubeX/meta-rules-dat@meta/geo/${kind}/${name}.list`,
    ];
    try {
      const text = await fetchWithFallbacks(urls, `${kind}/${name}`, 2);
      if (!text.trim()) throw new Error("空内容");
      await writeFile(file, text, "utf8");
      return text;
    } catch (err) {
      console.warn(`      [WARN] ${err.message}，尝试本地缓存`);
    }
  }
  try {
    return await readFile(file, "utf8");
  } catch {
    throw new Error(`geodata ${kind}/${name} 既无法下载也无本地缓存`);
  }
}

// ---------------------------------------------------------------- TS 小解析器

function stripComments(text) {
  let out = "";
  let i = 0;
  let quote = null;
  while (i < text.length) {
    const ch = text[i];
    if (quote) {
      out += ch;
      if (ch === "\\") {
        out += text[i + 1] ?? "";
        i += 2;
        continue;
      }
      if (ch === quote) quote = null;
      i++;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      quote = ch;
      out += ch;
      i++;
      continue;
    }
    if (ch === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      continue;
    }
    if (ch === "/" && text[i + 1] === "*") {
      i += 2;
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i++;
      i += 2;
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

function balanced(text, start, open, close) {
  let depth = 0;
  let quote = null;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      if (ch === "\\") {
        i++;
        continue;
      }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      quote = ch;
      continue;
    }
    if (ch === open) depth++;
    else if (ch === close) {
      depth--;
      if (depth === 0) return { body: text.slice(start + 1, i), end: i };
    }
  }
  return null;
}

function splitTopLevel(body, open, close) {
  const chunks = [];
  let depth = 0;
  let quote = null;
  let start = -1;
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (quote) {
      if (ch === "\\") i++;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      quote = ch;
      continue;
    }
    if (ch === open) {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === close) {
      depth--;
      if (depth === 0 && start >= 0) {
        chunks.push(body.slice(start + 1, i));
        start = -1;
      }
    }
  }
  return chunks;
}

const strField = (text, key) => {
  const m = text.match(new RegExp(`\\b${key}\\s*:\\s*"([^"]*)"`));
  return m ? m[1] : undefined;
};
const boolField = (text, key) => {
  const m = text.match(new RegExp(`\\b${key}\\s*:\\s*(true|false)`));
  return m ? m[1] === "true" : undefined;
};
const numField = (text, key) => {
  const m = text.match(new RegExp(`\\b${key}\\s*:\\s*(\\d+)`));
  return m ? Number(m[1]) : undefined;
};

function parseModules(srcText) {
  const clean = stripComments(srcText);
  const m = clean.match(/PROXY_GROUP_MODULES\s*:\s*ProxyGroupModule\[\]\s*=\s*\[/);
  if (!m) fatal("没找到 PROXY_GROUP_MODULES 定义（上游源码结构可能变了）");
  // 类型标注 ProxyGroupModule[] 里也有方括号，必须取整个匹配串的最后一个 '['
  const arr = balanced(clean, m.index + m[0].length - 1, "[", "]");
  if (!arr) fatal("PROXY_GROUP_MODULES 数组括号不配对");

  const modules = [];
  for (const obj of splitTopLevel(arr.body, "{", "}")) {
    const id = strField(obj, "id");
    if (!id) continue;
    const rulesIdx = obj.search(/\brules\s*:/);
    const head = rulesIdx >= 0 ? obj.slice(0, rulesIdx) : obj;
    const rules = [];
    if (rulesIdx >= 0) {
      const rStart = obj.indexOf("[", rulesIdx);
      if (rStart >= 0) {
        const rArr = balanced(obj, rStart, "[", "]");
        for (const rObj of splitTopLevel(rArr.body, "{", "}")) {
          const rid = strField(rObj, "id");
          const rpath = strField(rObj, "path");
          if (!rid || !rpath) continue;
          rules.push({
            id: rid,
            name: strField(rObj, "name") || rid,
            behavior: strField(rObj, "behavior") || "domain",
            path: rpath,
            noResolve: boolField(rObj, "noResolve") ?? false,
          });
        }
      }
    }
    modules.push({
      id,
      name: strField(head, "name") || id,
      emoji: strField(head, "emoji") || "",
      category: strField(head, "category") || "other",
      description: strField(head, "description") || "",
      groupType: strField(head, "groupType") || "select",
      rules,
    });
  }
  if (modules.length === 0) fatal("PROXY_GROUP_MODULES 解析出 0 个模块");
  return modules;
}

function parseRuleOrder(srcText) {
  const clean = stripComments(srcText);
  const m = clean.match(/RULE_ORDER\s*:\s*string\[\]\s*=\s*\[([\s\S]*?)\]/);
  if (!m) fatal("没找到 RULE_ORDER 定义");
  return [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]);
}

function parseExperimentalCn(srcText) {
  const clean = stripComments(srcText);
  const m = clean.match(/EXPERIMENTAL_CN_RULE\s*:\s*ProxyGroupRule\s*=\s*\{([\s\S]*?)\}/);
  if (!m) return null;
  return {
    id: strField(m[1], "id"),
    name: strField(m[1], "name"),
    path: strField(m[1], "path"),
    behavior: strField(m[1], "behavior") || "domain",
  };
}

function parsePresetExclusions(srcText, preset) {
  const clean = stripComments(srcText);
  const fnStart = clean.search(/function\s+getModulesForTemplate/);
  if (fnStart < 0) fatal("没找到 getModulesForTemplate()");
  const fnEnd = clean.indexOf("\n}", fnStart);
  const fn = clean.slice(fnStart, fnEnd > 0 ? fnEnd : clean.length);

  // full 分支的 case 体为空、直接 fallthrough 到 default:，
  // 所以必须读到下一个 case（或函数末尾）为止，否则会漏掉排除清单。
  const label = `case "${preset}":`;
  const idx = fn.indexOf(label);
  if (idx < 0) fatal(`getModulesForTemplate() 里没有 ${preset} 分支`);
  const rest = fn.slice(idx);
  const nextCase = rest.slice(label.length).search(/\bcase\s*"/);
  const body = nextCase >= 0 ? rest.slice(0, label.length + nextCase) : rest;

  if (/PROXY_GROUP_MODULES\.filter/.test(body)) {
    return { mode: "exclude", ids: [...body.matchAll(/m\.id\s*!==\s*"([^"]+)"/g)].map((x) => x[1]) };
  }
  const arrM = body.match(/return\s*\[([\s\S]*?)\]/);
  if (arrM) {
    return { mode: "include", ids: [...arrM[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]) };
  }
  fatal(`无法解析 ${preset} 分支的模块清单`);
}

function parseDefaults(srcText) {
  const clean = stripComments(srcText);
  const m = clean.match(/DEFAULT_SUBBOOST_CONFIG\s*=\s*\{([\s\S]*?)\n\}\s*as\s*const/);
  const body = m ? m[1] : clean;
  return {
    testUrl: strField(body, "testUrl") || "https://www.gstatic.com/generate_204",
    testInterval: numField(body, "testInterval") ?? 300,
    autoSelectStrategy: strField(body, "autoSelectStrategy") || "url-test",
    cnIpNoResolve: boolField(body, "cnIpNoResolve") ?? true,
    experimentalCnUseCnRuleSet: boolField(body, "experimentalCnUseCnRuleSet") ?? false,
  };
}

// ---------------------------------------------------------------- 规则计划

function geoSyntax(rule) {
  const p = rule.path || "";
  const m = p.match(/^(geosite|geoip)\/(.+?)\.mrs$/i);
  const base = m ? m[2] : p.replace(/^.*\//, "").replace(/\.mrs$/, "");
  const kind = m ? m[1].toLowerCase() : rule.behavior === "ipcidr" ? "geoip" : "geosite";
  if (kind === "geoip") return { kind, syntax: "GEOIP", value: normalizeGeoip(base) };
  return { kind, syntax: "GEOSITE", value: base };
}

/** GEOIP 两位字母国家码大写（cn -> CN），其余保持小写（private/google/telegram...） */
function normalizeGeoip(base) {
  return /^[a-z]{2}$/.test(base) ? base.toUpperCase() : base;
}

function buildRulePlan({ modules, ruleOrder, enabled, defaults, experimentalCn }) {
  const byId = new Map(modules.map((m) => [m.id, m]));
  const enabledSet = new Set(enabled);
  const entries = [];
  const emitted = new Set();
  const processed = new Set();

  const push = (module, rule) => {
    const key = `module:${module.id}:${rule.id}`;
    if (emitted.has(key)) return;
    emitted.add(key);
    entries.push({
      key,
      moduleId: module.id,
      group: module.name,
      ruleId: rule.id,
      summary: rule.name,
      ...geoSyntax(rule),
    });
  };

  const pushAppleTvPlus = () => {
    if (!enabledSet.has("streaming-west")) return;
    const mod = byId.get("streaming-west");
    const rule = mod?.rules.find((r) => r.id === "apple-tvplus");
    if (rule) push(mod, rule);
  };

  for (const moduleId of ruleOrder) {
    if (moduleId === "apple") pushAppleTvPlus();
    if (!enabledSet.has(moduleId)) continue;
    processed.add(moduleId);
    const mod = byId.get(moduleId);
    if (!mod) continue;
    for (const rule of mod.rules) push(mod, rule);
  }

  for (const mod of modules) {
    if (!enabledSet.has(mod.id) || processed.has(mod.id) || mod.id === "final") continue;
    for (const rule of mod.rules) push(mod, rule);
  }

  if (defaults.experimentalCnUseCnRuleSet && enabledSet.has("cn") && experimentalCn) {
    const cnModule = byId.get("cn");
    const key = "special:experimental-cn";
    if (cnModule && !emitted.has(key)) {
      emitted.add(key);
      entries.push({
        key,
        moduleId: "cn",
        group: cnModule.name,
        ruleId: experimentalCn.id,
        summary: experimentalCn.name,
        ...geoSyntax(experimentalCn),
      });
    }
  }

  const finalModule = byId.get("final");
  const selectModule = byId.get("select");
  const finalGroup = enabledSet.has("final")
    ? finalModule?.name
    : selectModule?.name || "🚀 节点选择";
  entries.push({
    key: "special:match",
    moduleId: "final",
    group: finalGroup,
    ruleId: "match",
    summary: "MATCH",
    syntax: "FINAL",
    value: "",
    kind: "final",
  });

  return entries;
}

/**
 * 把规则切成「连续且同策略组」的 run。
 * 只有相邻且同一策略组的规则才能合并 —— 同组不同段（如 apple-tvplus 与
 * streaming-west 其余规则之间隔着 apple/twitter/meta）绝不能合并。
 */
function buildRuns(entries) {
  const runs = [];
  const countByModule = new Map();
  for (const e of entries) {
    if (e.kind === "final") continue;
    const last = runs[runs.length - 1];
    if (last && last.group === e.group) {
      last.entries.push(e);
      continue;
    }
    const seen = (countByModule.get(e.moduleId) || 0) + 1;
    countByModule.set(e.moduleId, seen);
    runs.push({
      runId: seen > 1 ? `${e.moduleId}-${seen}` : e.moduleId,
      group: e.group,
      entries: [e],
    });
  }
  return runs;
}

// ---------------------------------------------------------------- geodata 转换

/**
 * 解析 MetaCubeX geosite 明文列表。
 *
 * 关键事实（2026-10 实测，勿凭记忆改）：
 *   MetaCubeX 的 geo/geosite/*.list 用的是「domain 行为」写法，大量条目带 `+.` 前缀
 *   （cn.list 111224 行 100% 是 `+.`；geolocation-cn 5341/5384），其余为裸域名。
 *   对照上游自己产出的 geo/geosite/*.yaml（payload 原样保留 `+.` 与裸域名）可确认：
 *   `+.domain` 与裸 `domain` 语义相同 —— 都是「本域及其子域」，即 DOMAIN-SUFFIX。
 *   所以这里统一去前缀后归入 domainSuffix；若直接原样输出会得到
 *   `DOMAIN-SUFFIX,+.xxx` 这种永不命中的废规则。
 */
function parseGeositeLines(text) {
  const domain = new Set();
  const domainSuffix = new Set();
  const domainKeyword = new Set();
  const domainRegex = new Set();
  let includes = 0;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#") || line.startsWith("//")) continue;
    if (line.startsWith("include:")) {
      includes++;
      continue;
    }
    if (line.startsWith("full:")) domain.add(line.slice(5).trim());
    else if (line.startsWith("keyword:")) domainKeyword.add(line.slice(8).trim());
    else if (line.startsWith("regexp:")) domainRegex.add(line.slice(7).trim());
    else if (line.startsWith("domain:")) domainSuffix.add(line.slice(7).trim());
    else if (line.startsWith("+.")) domainSuffix.add(line.slice(2).trim());
    else if (line.startsWith("*.")) domainSuffix.add(line.slice(2).trim());
    else domainSuffix.add(line);
  }
  return { domain, domainSuffix, domainKeyword, domainRegex, includes };
}

/**
 * 输出前的兜底自检。
 * 只检查 DOMAIN / DOMAIN-SUFFIX / IP-CIDR* 这几类「值必须是字面量」的规则；
 * DOMAIN-KEYWORD 与 DOMAIN-REGEX 的值本就可能含 * + ? 等字符，不能一刀切。
 */
function assertCleanPayload(payload) {
  const literalTypes = new Set(["DOMAIN", "DOMAIN-SUFFIX", "IP-CIDR", "IP-CIDR6"]);
  const bad = [];
  for (const line of payload) {
    const idx = line.indexOf(",");
    if (idx < 0) {
      bad.push(line);
      continue;
    }
    const type = line.slice(0, idx);
    const value = line.slice(idx + 1);
    if (!value) {
      bad.push(line);
      continue;
    }
    if (!literalTypes.has(type)) continue;
    if (value.includes(",") || /[+\s*?]/.test(value)) bad.push(line);
  }
  if (bad.length) {
    fatal(`生成的规则行含非法值 ${bad.length} 条，样例: ${bad.slice(0, 3).join(" | ")}`);
  }
}

function parseGeoipLines(text) {
  const ipCidr = new Set();
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    ipCidr.add(line);
  }
  return { ipCidr };
}

function yamlQuote(s) {
  return `'${String(s).replace(/'/g, "''")}'`;
}

/** 生成 mihomo classical 规则集（YAML payload，内容是完整规则行） */
function toClashYaml(payload) {
  const lines = ["payload:"];
  for (const item of payload) lines.push(`  - ${yamlQuote(item)}`);
  return lines.join("\n") + "\n";
}

/**
 * 生成 sing-box source 规则集（JSON）。
 * 注意：sing-box 里 domain 组（domain/domain_suffix/domain_keyword/domain_regex）
 * 与 destination-IP 组是「组间 AND、组内 OR」，所以域名与 IP 必须拆成两个 rule 对象，
 * 否则会变成「既要域名匹配又要 IP 匹配」的永假条件。
 */
function toSingboxJson(dom, ip) {
  const rules = [];
  const domainRule = {};
  if (dom.domain?.size) domainRule.domain = [...dom.domain].sort();
  if (dom.domainSuffix?.size) domainRule.domain_suffix = [...dom.domainSuffix].sort();
  if (dom.domainKeyword?.size) domainRule.domain_keyword = [...dom.domainKeyword].sort();
  if (dom.domainRegex?.size) domainRule.domain_regex = [...dom.domainRegex].sort();
  if (Object.keys(domainRule).length) rules.push(domainRule);
  if (ip.ipCidr?.size) rules.push({ ip_cidr: [...ip.ipCidr].sort() });
  if (rules.length === 0) fatal("生成的 sing-box 规则集为空");
  return JSON.stringify({ version: 1, rules }, null, 0) + "\n";
}

/** 把 run 里的 geosite/geoip 分类合并成 mihomo 规则行 */
async function buildRunPayload(run) {
  const dom = { domain: new Set(), domainSuffix: new Set(), domainKeyword: new Set(), domainRegex: new Set() };
  const ip = { ipCidr: new Set() };
  const sources = [];
  const seen = new Set();

  for (const e of run.entries) {
    if (e.kind !== "geosite" && e.kind !== "geoip") continue;
    const cat = e.kind === "geoip" ? e.value.toLowerCase() : e.value;
    const key = `${e.kind}/${cat}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const text = await fetchGeoList(e.kind, cat);
    sources.push(key);
    if (e.kind === "geosite") {
      const parsed = parseGeositeLines(text);
      for (const v of parsed.domain) dom.domain.add(v);
      for (const v of parsed.domainSuffix) dom.domainSuffix.add(v);
      for (const v of parsed.domainKeyword) dom.domainKeyword.add(v);
      for (const v of parsed.domainRegex) dom.domainRegex.add(v);
    } else {
      for (const v of parseGeoipLines(text).ipCidr) ip.ipCidr.add(v);
    }
  }

  const payload = [];
  for (const d of [...dom.domain].sort()) payload.push(`DOMAIN,${d}`);
  for (const d of [...dom.domainSuffix].sort()) payload.push(`DOMAIN-SUFFIX,${d}`);
  for (const d of [...dom.domainKeyword].sort()) payload.push(`DOMAIN-KEYWORD,${d}`);
  for (const d of [...dom.domainRegex].sort()) payload.push(`DOMAIN-REGEX,${d}`);
  for (const c of [...ip.ipCidr].sort()) {
    payload.push(`${c.includes(":") ? "IP-CIDR6" : "IP-CIDR"},${c}`);
  }
  if (payload.length === 0) fatal(`run ${run.runId} 生成 0 条规则`);
  assertCleanPayload(payload);

  return { payload, dom, ip, sources };
}

// ---------------------------------------------------------------- 渲染

function renderInlineIni({ entries, groupLines, meta }) {
  const L = [];
  const p = (s = "") => L.push(s);

  p("# ============================================================");
  p(`# SubBoost ${meta.presetName}规则 -> MiSub 自定义规则模板 (ini)`);
  p(`# 由 subboost2misub.mjs 自动生成于 ${meta.date}`);
  p(`# 上游: github.com/SubBoost/subboost @ ${meta.sha || "main"}`);
  p("#");
  p("# 【MiSub 识别格式要点 - 不要随意改动结构】");
  p("#   1. MiSub 只识别 [custom] / [proxy group] / [rule] 三个 section, 其它一律忽略。");
  p("#   2. 规则统一用 ruleset= 行表达以完整保留顺序; 写进 [rule] 会被 MiSub");
  p("#      排到所有 ruleset= 之前, 顺序被打乱。");
  p("#   3. custom_proxy_group= 的成员必须真实存在, 否则 MiSub 的");
  p("#      applySmartModelOptimizations 会剪掉空组, 并连带删除指向它的全部规则。");
  p("#   4. 成员语法: []名称 = 引用其它组 / .* = 全部节点 / (正则) = 按正则筛选;");
  p("#      url-test 末位为 间隔,,容差(秒)。");
  p("#   5. []GEOSITE,xxx / []GEOIP,xxx 为内联语法: Clash 出原生规则,");
  p("#      sing-box 自动映射 SagerNet .srs —— 双端都正确, 无需额外托管。");
  p("#   6. 规则顺序严格复刻 SubBoost rules.ts 的 buildCanonicalRuleEntries()。");
  p("# ============================================================");
  p("");
  p("[custom]");

  let section = "";
  for (const e of entries) {
    if (e.kind === "final") {
      p("");
      p("# ---- 最终兜底 ----");
    } else if (e.moduleId !== section) {
      section = e.moduleId;
      p("");
      p(`# ---- ${e.group}${e.key === "special:experimental-cn" ? " (低置信国内补充)" : ""} ----`);
    }
    const val = e.kind === "final" ? "[]FINAL" : `[]${e.syntax},${e.value}`;
    p(`ruleset=${e.group},${val}`);
  }

  p("");
  p("# ==================== 策略组 ====================");
  for (const line of groupLines) p(line);
  p("");
  p("enable_rule_generator=true");
  p("overwrite_original_rules=true");
  p("");
  return L.join("\n");
}

function renderRemoteIni({ runs, groupLines, meta, format, baseUrl }) {
  const L = [];
  const p = (s = "") => L.push(s);

  const flavor = format === "clash" ? "Clash / Mihomo" : "sing-box";
  p("# ============================================================");
  p(`# SubBoost ${meta.presetName}规则 -> MiSub 远程规则集模板 (${flavor})`);
  p(`# 由 subboost2misub.mjs 自动生成于 ${meta.date}`);
  p(`# 上游: github.com/SubBoost/subboost @ ${meta.sha || "main"}`);
  p("#");
  p("# 【本文件与内联版的区别】");
  p("#   规则内容不写死在 ini 里, 而是指向托管在 CDN 上的规则集文件。");
  p("#   客户端会按 24h 自动重拉这些规则集, 因此改规则无需重导 ini。");
  p("#");
  p("# 【只适用于一种内核】");
  p(`#   本文件是为 ${flavor} 生成的, 不要给另一个内核用:`);
  if (format === "clash") {
    p("#   MiSub 的 Clash 渲染器把远程规则集的 behavior 固定成 classical");
    p("#   (只有 chinaip/netflixip 等少数文件名会判成 ipcidr),");
    p("#   所以托管文件是 classical 规则行, sing-box 无法解析。");
  } else {
    p("#   MiSub 的 sing-box 渲染器只看扩展名: .srs -> binary, 其余 -> source;");
    p("#   sing-box 的 source 格式只支持 JSON, 所以托管文件是 JSON。");
  }
  p("#");
  p("# 【MiSub 通用格式要点】");
  p("#   1. 只识别 [custom] / [proxy group] / [rule] 三个 section。");
  p("#   2. 全部规则走 ruleset= 行以保留顺序; [rule] 的行会被前置到最前。");
  p("#   3. custom_proxy_group= 成员必须真实存在, 空组会被剪枝并连带删规则。");
  p("# ============================================================");
  p("");
  p("[custom]");

  let lastGroup = "";
  for (const run of runs) {
    if (run.group !== lastGroup) {
      p("");
      p(`# ---- ${run.group} ----`);
      lastGroup = run.group;
    }
    const ext = format === "clash" ? "yaml" : "json";
    p(`ruleset=${run.group},${baseUrl}/rules/${format}/sb-${run.runId}.${ext}`);
  }

  p("");
  p("# ---- 最终兜底 ----");
  p(`ruleset=${meta.finalGroup},[]FINAL`);

  p("");
  p("# ==================== 策略组 ====================");
  for (const line of groupLines) p(line);
  p("");
  p("enable_rule_generator=true");
  p("overwrite_original_rules=true");
  p("");
  return L.join("\n");
}

function buildProxyGroups({ modules, enabled, defaults, allNodes }) {
  const byId = new Map(modules.map((m) => [m.id, m]));
  const selectName = byId.get("select")?.name || "🚀 节点选择";
  const autoName = byId.get("auto")?.name || "⚡ 自动选择";
  const ref = (n) => `[]${n}`;
  const nodes = allNodes ? [".*"] : [];
  const lines = [];

  const emit = (name, type, members) => {
    lines.push(`custom_proxy_group=${name}\`${type}\`${members.join("`")}`);
  };

  for (const id of enabled) {
    const mod = byId.get(id);
    if (!mod) continue;
    const name = mod.name;

    switch (mod.groupType) {
      case "url-test":
      case "fallback":
        emit(name, defaults.autoSelectStrategy === "fallback" ? "fallback" : "url-test", [
          ".*",
          defaults.testUrl,
          `${defaults.testInterval},,50`,
        ]);
        break;
      case "reject-first":
        emit(name, "select", [ref("REJECT"), ref("DIRECT"), ref(selectName)]);
        break;
      case "direct-first":
        emit(name, "select", [ref("DIRECT"), ref("REJECT"), ref(selectName), ref(autoName)]);
        break;
      case "select":
      default:
        if (id === "select") {
          emit(name, "select", [ref(autoName), ref("DIRECT"), ref("REJECT"), ".*"]);
        } else {
          emit(name, "select", [ref(selectName), ref(autoName), ref("DIRECT"), ref("REJECT"), ...nodes]);
        }
        break;
    }
  }
  return lines;
}

// ---------------------------------------------------------------- 校验

function misubParse(text) {
  const lines = text.split(/\r?\n/);
  const rules = [];
  const groups = new Map();
  let section = null;

  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith("#") || line.startsWith(";")) continue;
    const sec = line.match(/^\[(.+)\]$/);
    if (sec) {
      section = sec[1].trim().toLowerCase();
      continue;
    }
    if (section !== "custom") continue;

    const eq = line.indexOf("=");
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    const val = line.slice(eq + 1).trim();

    if (key === "ruleset") {
      const c = val.indexOf(",");
      if (c < 0) continue;
      rules.push({ group: val.slice(0, c).trim(), content: val.slice(c + 1).trim() });
    } else if (key === "custom_proxy_group") {
      const parts = val.split("`").filter(Boolean);
      if (parts.length < 3) continue;
      const name = parts[0].trim();
      const type = parts[1].trim();
      const members = parts.slice(2).map((x) => x.trim()).filter(Boolean);
      const real = type === "url-test" || type === "fallback" ? members.slice(0, -2) : members;
      groups.set(name, { type, members: real });
    }
  }
  return { rules, groups };
}

/**
 * MiSub render-clash.js 里 ACL4SSR_IPCIDR_PROVIDER_FILES 的白名单。
 * 文件名命中它会被判成 behavior: ipcidr，我们就得输出裸 CIDR 而不是 classical 规则行；
 * 用 sb- 前缀命名可以保证永远不命中。
 */
const ACL4SSR_IPCIDR_FILENAMES = new Set([
  "amazonip",
  "chinacompanyip",
  "chinaip",
  "chinaipv6",
  "netflixip",
]);

/**
 * 校验远程规则集 URL 能否被 MiSub 按预期渲染。
 * 这一步是在拦「产物本身格式对、但 MiSub 会读错」的坑：
 *   · Clash 侧：文件名决定 behavior，命中 ipcidr 白名单就会读错格式
 *   · sing-box 侧：只有 .srs 是 binary，其余按 source(JSON) 解析，所以扩展名必须是 .json
 */
function verifyRemoteCompat(text, format, label) {
  const problems = [];
  for (const line of text.split(/\r?\n/)) {
    if (!/^ruleset=/.test(line)) continue;
    const content = line.slice(line.indexOf(",") + 1);
    if (!/^https?:\/\//i.test(content)) continue;

    const fileName = content.split("?")[0].split("/").pop() || "";
    const stem = fileName.replace(/\.(yaml|yml|list|txt|conf|json|srs)$/i, "").toLowerCase();

    if (format === "clash") {
      if (ACL4SSR_IPCIDR_FILENAMES.has(stem)) {
        problems.push(`${label}: 文件名 ${stem} 会被 MiSub 判为 ipcidr，但内容是 classical 规则行`);
      }
      if (!/\.(yaml|yml)$/i.test(fileName)) {
        problems.push(`${label}: Clash 规则集应为 .yaml，实际 ${fileName}`);
      }
    } else {
      if (!/\.json$/i.test(fileName)) {
        problems.push(
          `${label}: sing-box 规则集应为 .json（.srs 是 binary，其它会被当 source 解析），实际 ${fileName}`
        );
      }
    }
  }
  return problems;
}

function verifyIni(text, label) {
  const { rules, groups } = misubParse(text);
  const problems = [];
  const groupNames = new Set(groups.keys());

  if (rules.length === 0) problems.push(`${label}: 没有解析出任何规则`);
  if (groups.size === 0) problems.push(`${label}: 没有解析出任何策略组`);

  for (const r of rules) {
    if (!groupNames.has(r.group)) problems.push(`${label}: 规则指向未定义的策略组 ${r.group}`);
  }
  for (const [name, g] of groups) {
    if (g.members.length === 0) {
      problems.push(`${label}: 策略组为空(会被 MiSub 剪枝并连带删规则) ${name}`);
      continue;
    }
    for (const m of g.members) {
      const bare = m.startsWith("[]") ? m.slice(2) : m;
      if (bare === ".*" || bare === "DIRECT" || bare === "REJECT") continue;
      if (m.startsWith("[]") && !groupNames.has(bare) && bare !== name) {
        problems.push(`${label}: 策略组 [${name}] 引用了不存在的组 ${bare}`);
      }
    }
  }
  const last = rules[rules.length - 1];
  if (!last || last.content !== "[]FINAL") problems.push(`${label}: 最后一条规则不是 FINAL 兜底`);
  return { rules, groups, problems };
}

async function verifyGeodata(entries) {
  const uniq = [
    ...new Set(
      entries
        .filter((e) => e.kind === "geosite" || e.kind === "geoip")
        .map((e) => `${e.kind}:${e.value.toLowerCase()}`)
    ),
  ].map((s) => {
    const [kind, ...rest] = s.split(":");
    return { kind, value: rest.join(":") };
  });

  const results = [];
  const queue = [...uniq];
  const workers = Array.from({ length: 6 }, async () => {
    while (queue.length) {
      const g = queue.shift();
      let ok = false;
      try {
        await fetchGeoList(g.kind, g.value);
        ok = true;
      } catch {
        ok = false;
      }
      results.push({ ...g, ok });
    }
  });
  await Promise.all(workers);
  return { total: results.length, missing: results.filter((r) => !r.ok).map((r) => `${r.kind}:${r.value}`) };
}

// ---------------------------------------------------------------- 主流程

async function main() {
  console.log(`[1/6] 拉取 SubBoost 上游源码 (presets=${PRESETS.join(",")})`);
  const src = await loadSources();
  const sha = await latestCommitSha();

  console.log("[2/6] 解析源码");
  const modules = parseModules(src.modules);
  const ruleOrder = parseRuleOrder(src.rules);
  const experimentalCn = parseExperimentalCn(src.rules);
  const defaults = parseDefaults(src.defaults);
  console.log(
    `      模块 ${modules.length} 个; 默认开关 experimentalCnUseCnRuleSet=${defaults.experimentalCnUseCnRuleSet}, cnIpNoResolve=${defaults.cnIpNoResolve}`
  );

  // 逐预设构建规则计划
  const plans = {};
  for (const preset of PRESETS) {
    const spec = parsePresetExclusions(src.groups, preset);
    const enabled =
      spec.mode === "include"
        ? modules.filter((m) => spec.ids.includes(m.id)).map((m) => m.id)
        : modules.filter((m) => !spec.ids.includes(m.id)).map((m) => m.id);
    const entries = buildRulePlan({ modules, ruleOrder, enabled, defaults, experimentalCn });
    const groupLines = buildProxyGroups({ modules, enabled, defaults, allNodes: ALL_NODES });
    plans[preset] = {
      enabled,
      entries,
      groupLines,
      runs: buildRuns(entries),
      finalGroup: entries[entries.length - 1].group,
      exclusions: spec.mode === "exclude" ? spec.ids : [],
    };
    console.log(
      `      ${preset.padEnd(8)} 启用 ${String(enabled.length).padStart(2)} 组 · 规则 ${String(entries.length).padStart(3)} 条 · run ${plans[preset].runs.length} 段` +
        (plans[preset].exclusions.length ? ` (排除 ${plans[preset].exclusions.join("/")})` : "")
    );
  }

  const date = new Date().toISOString().slice(0, 10);

  // ---- 无 --dist 时保持旧的单文件行为 ----
  if (!DIST) {
    const preset = PRESETS[0];
    const plan = plans[preset];
    const ini = renderInlineIni({
      entries: plan.entries,
      groupLines: plan.groupLines,
      meta: { presetName: PRESET_META[preset].name, date, sha },
    });
    console.log("[3/6] 校验");
    const v = verifyIni(ini, "inline");
    if (v.problems.length) {
      for (const pr of v.problems) console.error(`      [FAIL] ${pr}`);
      fatal("校验未通过，不写文件");
    }
    console.log(`      MiSub 解析器模拟: PASS (规则 ${v.rules.length}, 组 ${v.groups.size})`);
    if (DO_GEODATA) {
      const g = await verifyGeodata(plan.entries);
      console.log(
        g.missing.length
          ? `      [WARN] 未找到的分类: ${g.missing.join(", ")}`
          : `      geodata 核验: PASS (${g.total} 个分类全部存在)`
      );
    }
    let oldText = null;
    try {
      oldText = await readFile(OUT, "utf8");
    } catch {
      oldText = null;
    }
    await writeFile(OUT, ini, "utf8");
    console.log(`[6/6] 写出 -> ${OUT}`);
    if (DO_DIFF) console.log(diffRules(oldText, ini) || "      规则 diff: 首次生成");
    return;
  }

  // ---- dist 模式 ----
  console.log("[3/6] 生成 dist 产物");

  const distMisub = join(DIST, "misub");
  const distRemote = join(DIST, "misub-remote");
  const distRules = join(DIST, "rules");
  const outFiles = [];

  const writeOut = async (absPath, content) => {
    await mkdir(dirname(absPath), { recursive: true });
    await writeFile(absPath, content, "utf8");
    const rel = absPath.slice(DIST.length + 1).split("\\").join("/");
    const bytes = Buffer.byteLength(content);
    outFiles.push({ path: rel, bytes, sha256: sha256(content) });
    return { rel, bytes };
  };

  // 3.1 内联版 ini（主推产物）
  const iniProblems = [];
  for (const preset of PRESETS) {
    const plan = plans[preset];
    const ini = renderInlineIni({
      entries: plan.entries,
      groupLines: plan.groupLines,
      meta: { presetName: PRESET_META[preset].name, date, sha },
    });
    const v = verifyIni(ini, `inline/${preset}`);
    iniProblems.push(...v.problems);
    await writeOut(join(distMisub, `SubBoost_${PRESET_META[preset].slug}_MiSub.ini`), ini);
  }
  console.log(`      内联版 ini: ${PRESETS.length} 份`);

  // 3.2 远程规则集
  const wantRules = RULE_FORMATS.filter((f) => f !== "none");
  let ruleStats = { runs: 0, sources: 0, payload: 0 };

  if (wantRules.length) {
    if (!RULE_BASE_URL) {
      fatal("--dist 且需要远程规则集时必须提供 --gh-owner 与 --gh-repo（或 --rule-base-url）");
    }
    // run 的去重并集：不同预设共享同一 runId 时只生成一次
    const runMap = new Map();
    for (const preset of PRESETS) {
      for (const run of plans[preset].runs) {
        if (!runMap.has(run.runId)) runMap.set(run.runId, run);
      }
    }
    const runs = [...runMap.values()];
    console.log(`      远程规则集: ${runs.length} 段 (${wantRules.join(" + ")})`);

    const queue = [...runs];
    const concurrency = 5;
    let done = 0;
    const workers = Array.from({ length: concurrency }, async () => {
      while (queue.length) {
        const run = queue.shift();
        const { payload, dom, ip, sources } = await buildRunPayload(run);
        ruleStats.sources += sources.length;
        ruleStats.payload = Math.max(ruleStats.payload, payload.length);
        if (wantRules.includes("clash")) {
          const yaml = toClashYaml(payload);
          const first = yaml.split(/\r?\n/)[0];
          if (first !== "payload:") fatal(`run ${run.runId} 的 YAML 首行不是 payload:`);
          await writeOut(join(distRules, "clash", `sb-${run.runId}.yaml`), yaml);
        }
        if (wantRules.includes("singbox")) {
          const json = toSingboxJson(dom, ip);
          let parsed;
          try {
            parsed = JSON.parse(json);
          } catch (err) {
            fatal(`run ${run.runId} 的 JSON 无法回读: ${err.message}`);
          }
          if (parsed.version !== 1 || !Array.isArray(parsed.rules) || parsed.rules.length === 0) {
            fatal(`run ${run.runId} 的 JSON 结构非法`);
          }
          await writeOut(join(distRules, "singbox", `sb-${run.runId}.json`), json);
        }
        done++;
        process.stdout.write(`\r      已生成 ${done}/${runs.length} 段规则集   `);
      }
    });
    await Promise.all(workers);
    process.stdout.write("\n");
    ruleStats.runs = runs.length;

    // 3.3 远程引用版 ini
    for (const preset of PRESETS) {
      const plan = plans[preset];
      for (const format of wantRules) {
        const ini = renderRemoteIni({
          runs: plan.runs,
          groupLines: plan.groupLines,
          meta: { presetName: PRESET_META[preset].name, date, sha, finalGroup: plan.finalGroup },
          format,
          baseUrl: RULE_BASE_URL,
        });
        const v = verifyIni(ini, `remote-${format}/${preset}`);
        iniProblems.push(...v.problems);
        iniProblems.push(...verifyRemoteCompat(ini, format, `remote-${format}/${preset}`));
        await writeOut(
          join(distRemote, `SubBoost_${PRESET_META[preset].slug}_MiSub_${format}.ini`),
          ini
        );
      }
    }
    console.log(`      远程引用版 ini: ${PRESETS.length * wantRules.length} 份`);
  } else {
    console.log("      远程规则集: 已跳过 (--rules none)");
  }

  // 3.4 上游指纹（用于判断「结构是否变化」，避免无意义提交）
  const fingerprint = sha256(
    JSON.stringify({
      order: ruleOrder,
      experimentalCn: experimentalCn?.id || null,
      defaults: {
        cnIpNoResolve: defaults.cnIpNoResolve,
        experimentalCnUseCnRuleSet: defaults.experimentalCnUseCnRuleSet,
      },
      presets: Object.fromEntries(
        PRESETS.map((p) => [
          p,
          plans[p].entries.map((e) => `${e.moduleId}|${e.ruleId}|${e.group}|${e.syntax}|${e.value}`),
        ])
      ),
    })
  );
  const upstream = {
    subboostCommit: sha,
    structureFingerprint: fingerprint,
    generatedAt: new Date().toISOString(),
    presets: PRESETS,
  };
  await writeOut(join(DIST, "upstream.json"), JSON.stringify(upstream, null, 2) + "\n");

  // 3.5 manifest
  const manifest = {
    generatedAt: new Date().toISOString(),
    generator: "subboost2misub.mjs",
    upstream,
    ruleBaseUrl: RULE_BASE_URL || null,
    presets: Object.fromEntries(
      PRESETS.map((p) => [
        p,
        {
          label: PRESET_META[p].name,
          groups: plans[p].groupLines.length,
          rules: plans[p].entries.length,
          runs: plans[p].runs.length,
        },
      ])
    ),
    ruleSets: wantRules.length
      ? { runs: ruleStats.runs, formats: wantRules, sourceListCount: ruleStats.sources }
      : null,
    files: outFiles.sort((a, b) => a.path.localeCompare(b.path)),
  };
  await writeOut(join(DIST, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");

  console.log("[4/6] 校验");
  if (iniProblems.length) {
    for (const pr of iniProblems.slice(0, 30)) console.error(`      [FAIL] ${pr}`);
    fatal(`ini 校验未通过 (${iniProblems.length} 项)`);
  }
  const totalIni = PRESETS.length * Math.max(1, wantRules.length);
  console.log(`      MiSub 解析器模拟: PASS (${totalIni} 份 ini, 无空组/无悬空引用/FINAL 在末位)`);

  if (DO_GEODATA) {
    const allEntries = Object.values(plans).flatMap((p) => p.entries);
    const g = await verifyGeodata(allEntries);
    console.log(
      g.missing.length
        ? `      [WARN] 未找到的分类: ${g.missing.join(", ")}`
        : `      geodata 核验: PASS (${g.total} 个分类全部存在)`
    );
  }

  console.log("[5/6] 体积统计");
  const totalBytes = outFiles.reduce((a, f) => a + f.bytes, 0);
  const byDir = new Map();
  for (const f of outFiles) {
    const d = f.path.split("/").slice(0, 2).join("/");
    byDir.set(d, (byDir.get(d) || 0) + f.bytes);
  }
  for (const [d, b] of [...byDir.entries()].sort()) {
    console.log(`      ${d.padEnd(18)} ${(b / 1024).toFixed(1)} KB`);
  }
  console.log(`      文件数 ${outFiles.length}, 合计 ${(totalBytes / 1024 / 1024).toFixed(2)} MB`);

  console.log("[6/6] 完成");
  console.log(`      -> ${DIST}`);
  console.log(`      主链接 ${RULE_BASE_URL ? RULE_BASE_URL.replace(/@[^/]*$/, "") : ""}`);
}

function diffRules(oldText, newText) {
  if (!oldText) return null;
  const norm = (t) =>
    t
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l.startsWith("ruleset="))
      .map((l) => l.replace(/^ruleset=/, ""));
  const a = norm(oldText);
  const b = norm(newText);
  const added = b.filter((x) => !a.includes(x));
  const removed = a.filter((x) => !b.includes(x));
  if (!added.length && !removed.length) return "      规则 diff: 无变化";
  const lines = ["      规则 diff:"];
  for (const r of removed) lines.push(`        - ${r}`);
  for (const r of added) lines.push(`        + ${r}`);
  return lines.join("\n");
}

main().catch((err) => {
  console.error(`[FATAL] ${err.stack || err.message}`);
  process.exit(1);
});
