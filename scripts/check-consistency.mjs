#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 n2far2000
/**
 * check-consistency.mjs —— 产物一致性校验（本地 vs CI、构建 A vs 构建 B）
 *
 * 用途：证明「同一份脚本 + 同一份上游输入」产出的 dist 完全一致，
 *       从而证明 CI 构建与本地构建走的是同一套规则改写逻辑。
 *
 * 两种模式：
 *   full（默认）     逐文件比对，只归一化掉必然变化的时间戳。
 *                    要求两个目录的文件集合完全相同。
 *   structure        只比对结构指纹（预设的 provider 数 / 策略组数 / 聚合表来源 /
 *                    文件清单），允许规则条目数随上游更新而浮动。
 *                    用于「上游数据已变，但要确认改写逻辑没跑偏」的场景。
 *
 * 归一化规则（full 模式）：
 *   · *.ini            删除 `# 由 loyalsoldier2misub.mjs 自动生成于 ...` 行
 *   · manifest.json    删除 generatedAt 字段
 *   · upstream.json    删除 fetchedAt 字段
 * 除此之外的任何字节差异都算失败。
 *
 * 用法：
 *   node scripts/check-consistency.mjs --left dist --right /tmp/dist2
 *   node scripts/check-consistency.mjs --left dist --right /tmp/dist2 --mode structure
 *   node scripts/check-consistency.mjs --left dist --right /tmp/dist2 --allow-extra
 *
 * 退出码：0 一致；1 不一致；2 用法或 IO 错误。
 */

import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative, resolve, dirname } from "node:path";

const argv = process.argv.slice(2);
const arg = (name, dflt) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : dflt;
};
const has = (name) => argv.includes(`--${name}`);

const LEFT = arg("left", null);
const RIGHT = arg("right", null);
const MODE = arg("mode", "full");
const ALLOW_EXTRA = has("allow-extra");

if (!LEFT || !RIGHT) {
  console.log("用法: node check-consistency.mjs --left <目录A> --right <目录B> [--mode full|structure] [--allow-extra]");
  process.exit(2);
}
if (!["full", "structure"].includes(MODE)) {
  console.log(`未知模式: ${MODE}（可选 full / structure）`);
  process.exit(2);
}

// ---------------------------------------------------------------- 收集

async function walk(root, base = root, out = []) {
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (e) {
    console.error(`无法读取目录 ${root}: ${e.message}`);
    process.exit(2);
  }
  for (const ent of entries) {
    const p = join(root, ent.name);
    if (ent.isDirectory()) await walk(p, base, out);
    else if (ent.isFile()) out.push(relative(base, p).replace(/\\/g, "/"));
  }
  return out;
}

/** 归一化：抹掉每次构建必然变化的字段 */
function normalize(rel, text) {
  if (rel.endsWith(".ini")) {
    return text
      .split(/\r?\n/)
      .filter((l) => !/^#\s*由\s*loyalsoldier2misub\.mjs\s*自动生成于/.test(l))
      .join("\n");
  }
  if (rel === "manifest.json") {
    try {
      const d = JSON.parse(text);
      delete d.generatedAt;
      return JSON.stringify(d, null, 2);
    } catch {
      return text;
    }
  }
  if (rel === "upstream.json") {
    try {
      const d = JSON.parse(text);
      delete d.fetchedAt;
      return JSON.stringify(d, null, 2);
    } catch {
      return text;
    }
  }
  return text;
}

async function loadTree(root) {
  const files = await walk(root);
  const map = new Map();
  for (const rel of files) {
    const raw = await readFile(join(root, rel), "utf8");
    map.set(rel, normalize(rel, raw));
  }
  return map;
}

// ---------------------------------------------------------------- 结构指纹

function structureOf(tree) {
  const manifestRaw = tree.get("manifest.json");
  if (!manifestRaw) return null;
  let m;
  try {
    m = JSON.parse(manifestRaw);
  } catch {
    return null;
  }
  const presets = m.presetsSummary || {};
  const aggregates = m.aggregates || {};
  return {
    presets: Object.fromEntries(
      Object.entries(presets).map(([k, v]) => [k, { providers: v.providers, groups: v.groups }])
    ),
    aggregateSources: Object.fromEntries(
      Object.entries(aggregates).map(([k, v]) => [k, (v.sources || []).join("+")])
    ),
    files: [...tree.keys()].filter((f) => /^misub(-\w+)?\//.test(f)).sort(),
    aggregateFiles: [...tree.keys()].filter((f) => /^rules\/(clash|singbox)\/agg-/.test(f)).sort(),
  };
}

// ---------------------------------------------------------------- 主流程

const A = await loadTree(resolve(LEFT));
const B = await loadTree(resolve(RIGHT));

console.log(`=== 产物一致性校验 [${MODE}] ===`);
console.log(`A: ${resolve(LEFT)}  ${A.size} 个文件`);
console.log(`B: ${resolve(RIGHT)}  ${B.size} 个文件\n`);

if (MODE === "structure") {
  const sa = structureOf(A);
  const sb = structureOf(B);
  if (!sa || !sb) {
    console.log("失败：缺少 manifest.json，无法比对结构指纹");
    process.exit(1);
  }
  const diffs = [];
  const keys = new Set([...Object.keys(sa.presets), ...Object.keys(sb.presets)]);
  for (const k of keys) {
    const x = sa.presets[k];
    const y = sb.presets[k];
    if (!x || !y) {
      diffs.push(`预设 ${k} 仅存在于一侧`);
      continue;
    }
    if (x.providers !== y.providers) diffs.push(`预设 ${k} 的 provider 数: ${x.providers} vs ${y.providers}`);
    if (x.groups !== y.groups) diffs.push(`预设 ${k} 的策略组数: ${x.groups} vs ${y.groups}`);
  }
  for (const k of new Set([...Object.keys(sa.aggregateSources), ...Object.keys(sb.aggregateSources)])) {
    if (sa.aggregateSources[k] !== sb.aggregateSources[k]) {
      diffs.push(`聚合表 ${k} 的来源: ${sa.aggregateSources[k] || "(缺)"} vs ${sb.aggregateSources[k] || "(缺)"}`);
    }
  }
  for (const label of ["files", "aggregateFiles"]) {
    const onlyA = sa[label].filter((f) => !sb[label].includes(f));
    const onlyB = sb[label].filter((f) => !sa[label].includes(f));
    for (const f of onlyA) diffs.push(`${f} 只在 A 中存在`);
    for (const f of onlyB) diffs.push(`${f} 只在 B 中存在`);
  }

  console.log("--- 结构指纹 ---");
  for (const [k, v] of Object.entries(sa.presets)) {
    console.log(`  ${k.padEnd(12)} providers=${v.providers}  groups=${v.groups}`);
  }
  for (const [k, v] of Object.entries(sa.aggregateSources)) {
    console.log(`  ${k.padEnd(12)} <- ${v}`);
  }
  console.log("");
  if (diffs.length === 0) {
    console.log("结构指纹一致（改写逻辑一致；条目数允许随上游更新浮动）");
    process.exit(0);
  }
  console.log("结构指纹不一致:");
  for (const d of diffs) console.log(`  · ${d}`);
  process.exit(1);
}

// full 模式
const allKeys = [...new Set([...A.keys(), ...B.keys()])].sort();
const onlyA = [];
const onlyB = [];
const changed = [];

for (const k of allKeys) {
  const inA = A.has(k);
  const inB = B.has(k);
  if (inA && !inB) onlyA.push(k);
  else if (!inA && inB) onlyB.push(k);
  else if (A.get(k) !== B.get(k)) changed.push(k);
}

const sections = [
  ["仅 A 存在", onlyA],
  ["仅 B 存在", onlyB],
  ["内容不同", changed],
];

let bad = changed.length > 0;
for (const [label, list] of sections) {
  console.log(`--- ${label}: ${list.length} ---`);
  for (const f of list.slice(0, 40)) console.log(`  ${f}`);
  if (list.length > 40) console.log(`  ... 另有 ${list.length - 40} 个`);
}

// 新增/消失文件是否算失败
const extraBad = (onlyA.length + onlyB.length) > 0 && !ALLOW_EXTRA;
if (extraBad) bad = true;

console.log("");
if (!bad) {
  console.log(`一致：${allKeys.length} 个文件全部相同（已归一化生成时间戳）`);
  process.exit(0);
}
if (changed.length === 0 && !extraBad) {
  console.log("一致（差异仅为新增/删除文件，已用 --allow-extra 放行）");
  process.exit(0);
}
console.log("不一致");
process.exit(1);
