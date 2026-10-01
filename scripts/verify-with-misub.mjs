#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 n2far2000 <n2far2000@users.noreply.github.com>
/**
 * verify-with-misub.mjs
 *
 * 用 MiSub 官方渲染管线（而非本项目内的复刻实现）验证生成的 ini。
 *
 * subboost2misub.mjs 的 --verify 是「复刻 MiSub 解析逻辑做模拟」，用于快速回归；
 * 本脚本直接 import MiSub 源码里的模板管线，用于核对复刻实现是否与上游一致。
 * 两者互补：前者零依赖、可离线；后者是权威口径，需要 MiSub 源码。
 *
 * 用法：
 *   git clone --depth 1 https://github.com/imzyb/MiSub /path/to/MiSub
 *   cd /path/to/MiSub && npm install
 *   node <repo>/scripts/verify-with-misub.mjs --misub /path/to/MiSub dist/misub/SubBoost_Full_MiSub.ini
 *
 * 校验内容：
 *   · 产出合法 YAML / JSON，且策略组、规则数量非零
 *   · 所有规则的目标策略均存在（无悬空引用）
 *   · 不存在空策略组（MiSub 会剪掉空组并连带删除指向它的规则）
 *   · MATCH 兜底位于规则表末位
 *   · sing-box 的 remote rule_set 均带 url
 */

import { readFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";

const argv = process.argv.slice(2);
const arg = (name) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : null;
};
const has = (name) => argv.includes(`--${name}`);

// 位置参数 = 去掉选项本身及其取值后的剩余项
const positional = [];
for (let i = 0; i < argv.length; i++) {
  if (argv[i].startsWith("--")) {
    if (argv[i] === "--misub") i++;
    continue;
  }
  positional.push(argv[i]);
}

const MISUB_ARG = arg("misub");

if (has("help") || !MISUB_ARG || positional.length === 0) {
  console.log(`用法: node verify-with-misub.mjs --misub <MiSub源码目录> <ini文件...>

选项:
  --misub <dir>   MiSub 仓库根目录（需已 npm install，以提供 js-yaml）
  --keep-going    单个文件失败后继续校验其余文件

示例:
  node verify-with-misub.mjs --misub ../MiSub \\
    dist/misub/SubBoost_Full_MiSub.ini \\
    dist/misub-remote/SubBoost_Full_MiSub_clash.ini`);
  process.exit(2);
}

const MISUB_DIR = resolve(MISUB_ARG);
const KEEP_GOING = has("keep-going");
const files = positional;

// MiSub 的模板管线是 ESM，且内部有相对导入，因此必须从 MiSub 目录加载
const pipelineUrl = pathToFileURL(
  join(MISUB_DIR, "functions/modules/subscription/template-pipeline.js")
).href;

let renderClashFromIniTemplate;
let renderSingboxFromIniTemplate;
let yaml;
try {
  ({ renderClashFromIniTemplate, renderSingboxFromIniTemplate } = await import(pipelineUrl));
  yaml = (await import(pathToFileURL(join(MISUB_DIR, "node_modules/js-yaml/index.js")).href))
    .default;
} catch (err) {
  console.error(`[ERROR] 无法加载 MiSub 模块: ${err.message}`);
  console.error(`        请确认：`);
  console.error(`          1) --misub 指向 MiSub 仓库根目录`);
  console.error(`          2) 已在该目录执行 npm install（提供 js-yaml）`);
  process.exit(2);
}

// 覆盖多地区的模拟节点，用于触发地区分组的自动注入。
// 以下均为虚构占位值，仅用于让渲染器走完分组逻辑，不涉及任何真实凭据。
const PROXIES = [
  ["🇭🇰 香港 01", "hk1"],
  ["🇭🇰 香港 02", "hk2"],
  ["🇯🇵 日本 01", "jp1"],
  ["🇸🇬 新加坡 01", "sg1"],
  ["🇺🇸 美国 01", "us1"],
  ["🇹🇼 台湾 01", "tw1"],
].map(([name, host]) => ({
  name,
  type: "ss",
  server: `${host}.example.com`,
  port: 443,
  cipher: "aes-128-gcm",
  password: "placeholder",
}));

const RENDER_PARAMS = {
  proxies: PROXIES,
  targetFormat: "clash",
  ruleLevel: "none",
  interval: 86400,
  skipCertVerify: false,
  enableUdp: true,
  isMeta: true,
};

const BUILTIN_POLICIES = new Set(["DIRECT", "REJECT", "REJECT-DROP", "PASS", "COMPATIBLE"]);
const RULE_MODIFIERS = new Set(["no-resolve", "src"]);

function verifyClash(text) {
  const problems = [];
  const cfg = yaml.load(text);
  if (!cfg || typeof cfg !== "object") return { problems: ["Clash 输出不是合法 YAML 对象"], stats: {} };

  const groups = Array.isArray(cfg["proxy-groups"]) ? cfg["proxy-groups"] : [];
  const groupNames = new Set(groups.map((g) => g.name));
  const rules = (Array.isArray(cfg.rules) ? cfg.rules : []).map(String);

  const dangling = [];
  for (const rule of rules) {
    const policy = rule.split(",").pop().trim();
    if (BUILTIN_POLICIES.has(policy) || RULE_MODIFIERS.has(policy)) continue;
    if (!groupNames.has(policy)) dangling.push(`${rule} → ${policy}`);
  }
  const emptyGroups = groups.filter((g) => !Array.isArray(g.proxies) || g.proxies.length === 0);
  const matchIndex = rules.findIndex((r) => /^MATCH,/i.test(r));

  if (!rules.length) problems.push("未产出任何规则");
  if (!groups.length) problems.push("未产出任何策略组");
  if (dangling.length) {
    problems.push(`悬空策略引用 ${dangling.length} 条：${dangling.slice(0, 3).join(" | ")}`);
  }
  if (emptyGroups.length) {
    problems.push(`空策略组 ${emptyGroups.length} 个：${emptyGroups.map((g) => g.name).join(", ")}`);
  }
  if (matchIndex !== rules.length - 1) problems.push("MATCH 兜底不在规则表末位");

  return {
    problems,
    stats: {
      目标: "Clash",
      字节: text.length,
      节点: Array.isArray(cfg.proxies) ? cfg.proxies.length : 0,
      策略组: groups.length,
      规则: rules.length,
      GEOSITE: rules.filter((r) => /^GEOSITE,/i.test(r)).length,
      GEOIP: rules.filter((r) => /^GEOIP,/i.test(r)).length,
      rule_providers: cfg["rule-providers"] ? Object.keys(cfg["rule-providers"]).length : 0,
      兜底: matchIndex >= 0 ? rules[matchIndex].split(",").slice(1).join(",") : "(无)",
    },
  };
}

function verifySingbox(text) {
  const problems = [];
  let cfg;
  try {
    cfg = JSON.parse(text);
  } catch (err) {
    return { problems: [`sing-box 输出不是合法 JSON: ${err.message}`], stats: {} };
  }

  const outbounds = Array.isArray(cfg.outbounds) ? cfg.outbounds : [];
  const tags = new Set(outbounds.map((o) => o.tag));
  const routeRules = cfg.route?.rules ?? [];
  const ruleSets = cfg.route?.rule_set ?? [];

  const dangling = [...new Set(routeRules.map((r) => r.outbound).filter((t) => t && !tags.has(t)))];
  const emptyOutbounds = outbounds.filter(
    (o) => Array.isArray(o.outbounds) && o.outbounds.length === 0
  );
  const missingUrl = ruleSets.filter((r) => r.type === "remote" && !r.url).map((r) => r.tag);

  if (!routeRules.length) problems.push("未产出任何 route 规则");
  if (!outbounds.length) problems.push("未产出任何 outbound");
  if (dangling.length) problems.push(`悬空 outbound ${dangling.length} 个：${dangling.slice(0, 3).join(", ")}`);
  if (emptyOutbounds.length) problems.push(`空 selector ${emptyOutbounds.length} 个`);
  if (missingUrl.length) problems.push(`remote rule_set 缺 url：${missingUrl.slice(0, 3).join(", ")}`);

  return {
    problems,
    stats: {
      目标: "sing-box",
      字节: text.length,
      outbounds: outbounds.length,
      route规则: routeRules.length,
      rule_set: ruleSets.length,
      rule_set类型: [...new Set(ruleSets.map((r) => r.type))].join("/") || "(无)",
      兜底: cfg.route?.final ?? "(未设置)",
    },
  };
}

let failed = 0;
for (const file of files) {
  const path = resolve(file);
  console.log(`\n${"=".repeat(72)}\n${path}\n${"=".repeat(72)}`);

  let templateText;
  try {
    templateText = await readFile(path, "utf8");
  } catch (err) {
    console.log(`[ERROR] 无法读取文件: ${err.message}`);
    failed++;
    if (!KEEP_GOING) break;
    continue;
  }

  const problems = [];
  const stats = [];

  try {
    const clash = verifyClash(renderClashFromIniTemplate(templateText, RENDER_PARAMS));
    problems.push(...clash.problems);
    stats.push(clash.stats);
  } catch (err) {
    problems.push(`Clash 渲染抛异常: ${err.message}`);
  }

  try {
    const singbox = verifySingbox(
      renderSingboxFromIniTemplate(templateText, { ...RENDER_PARAMS, targetFormat: "sing-box" })
    );
    problems.push(...singbox.problems);
    stats.push(singbox.stats);
  } catch (err) {
    problems.push(`sing-box 渲染抛异常: ${err.message}`);
  }

  for (const s of stats) {
    console.log("\n" + Object.entries(s).map(([k, v]) => `  ${k}: ${v}`).join("\n"));
  }

  if (problems.length) {
    console.log("\n[FAIL]");
    for (const p of problems) console.log(`  · ${p}`);
    failed++;
    if (!KEEP_GOING) break;
  } else {
    console.log("\n[PASS] MiSub 官方渲染管线产出合法配置");
  }
}

console.log();
if (failed) {
  console.log(`结果：${failed}/${files.length} 个文件未通过`);
  process.exit(1);
}
console.log(`结果：${files.length} 个文件全部通过`);
