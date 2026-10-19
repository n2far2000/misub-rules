#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 n2far2000 <n2far2000@users.noreply.github.com>
/**
 * check-links.mjs
 *
 * 全量链接体检：枚举 main 与 dist 分支的全部文件，逐个实测
 * jsDelivr / raw.githubusercontent.com / GitHub 页面三个通道，
 * 再校验产物结构、文档链接与旧 SHA 是否复活。
 *
 * 零依赖，仅用 Node 内置 fetch。判据为「真实失败 0 且旧 SHA 复活 0
 * 且文档链接全通」时退出码 0，可直接接入 CI 做回归。
 *
 * 用法：
 *   node scripts/check-links.mjs
 *   node scripts/check-links.mjs --owner <账号> --repo <仓库>
 */

import { createHash } from 'node:crypto';

const OWNER = argVal('--owner') || 'n2far2000';
const REPO = argVal('--repo') || 'misub-rules';
const BRANCHES = ['main', 'dist'];
const CONCURRENCY = 6;

function argVal(flag) {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : null;
}

async function head(url, tries = 3) {
  for (let i = 1; i <= tries; i++) {
    try {
      const ctl = new AbortController();
      const t = setTimeout(() => ctl.abort(), 20000);
      const r = await fetch(url, { method: 'GET', signal: ctl.signal, redirect: 'follow' });
      clearTimeout(t);
      const body = await r.text();
      return { status: r.status, len: body.length, head: body.slice(0, 40).replace(/\n/g, '\\n') };
    } catch (e) {
      if (i === tries) return { status: 0, len: 0, head: 'ERR ' + e.message };
      await new Promise((s) => setTimeout(s, 1500 * i));
    }
  }
}

async function apiJson(url) {
  const r = await fetch(url, { headers: { 'User-Agent': 'link-checker' } });
  if (!r.ok) throw new Error(`API ${r.status} ${url}`);
  return r.json();
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let idx = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (idx < items.length) {
      const my = idx++;
      out[my] = await fn(items[my], my);
    }
  });
  await Promise.all(workers);
  return out;
}

function md5(s) {
  return createHash('md5').update(s, 'utf8').digest('hex');
}

async function main() {
  console.log(`\n=== 仓库 ${OWNER}/${REPO} 全量链接体检 ===`);
  console.log(`时间: ${new Date().toISOString()}\n`);

  // 1. 仓库基本信息
  let repoInfo;
  try {
    repoInfo = await apiJson(`https://api.github.com/repos/${OWNER}/${REPO}`);
  } catch (e) {
    console.log(`仓库 API 失败: ${e.message}`);
    process.exit(1);
  }
  console.log(`仓库: ${repoInfo.full_name}  private=${repoInfo.private}  default=${repoInfo.default_branch}`);
  console.log(`许可: ${repoInfo.license?.spdx_id || 'N/A'}  创建于: ${repoInfo.created_at}`);
  console.log(`大小: ${repoInfo.size} KB\n`);

  // 2. 枚举分支文件
  const filesByBranch = {};
  for (const br of BRANCHES) {
    const tree = await apiJson(`https://api.github.com/repos/${OWNER}/${REPO}/git/trees/${br}?recursive=1`);
    filesByBranch[br] = tree.tree.filter((x) => x.type === 'blob').map((x) => x.path);
    console.log(`分支 ${br}: ${filesByBranch[br].length} 个文件, truncated=${tree.truncated}`);
  }
  console.log('');

  // 3. 各分支根提交数（历史深度）
  for (const br of BRANCHES) {
    const ref = await apiJson(`https://api.github.com/repos/${OWNER}/${REPO}/commits?sha=${br}&per_page=100`);
    const parents = ref[0]?.parents?.length ?? -1;
    console.log(`分支 ${br}: 可见提交 ${ref.length} 个, HEAD=${ref[0]?.sha?.slice(0, 40)} 父提交数=${parents}`);
  }
  console.log('');

  // 4. 逐个文件测三个通道
  const tasks = [];
  for (const br of BRANCHES) {
    for (const p of filesByBranch[br]) {
      tasks.push({
        br,
        path: p,
        jsdelivr: `https://cdn.jsdelivr.net/gh/${OWNER}/${REPO}@${br}/${p}`,
        raw: `https://raw.githubusercontent.com/${OWNER}/${REPO}/${br}/${p}`,
        gh: `https://github.com/${OWNER}/${REPO}/blob/${br}/${p}`,
      });
    }
  }

  console.log(`开始实测 ${tasks.length} 个文件 × 3 通道 = ${tasks.length * 3} 次请求...\n`);
  const results = await mapLimit(tasks, CONCURRENCY, async (t) => {
    // gh 仅为参考项，只试 1 次，避免 93 个文件 × 3 次 × 20 秒拖长总耗时
    const [j, r, g] = await Promise.all([head(t.jsdelivr), head(t.raw), head(t.gh, 1)]);
    return { ...t, j, r, g };
  });

  // 5. 统计
  //
  // 判定口径：产物的可用性由 **jsDelivr 与 raw 两个实际分发通道** 决定。
  // gh（github.com/blob 页面）只作参考 —— 它是 240 KB 的 HTML 页面，
  // 国内直连常需 17–20 秒，几乎必然撞上 20 秒超时，把它当门禁会稳定误报
  // （2026-10-19 实测：58 个「失败」全部是该通道超时，jsDelivr 与 raw 均 200）。
  let ok = 0, bad = 0;
  const failures = [];
  for (const x of results) {
    const pass = x.j.status === 200 && x.r.status === 200;
    if (pass) ok++;
    else {
      bad++;
      failures.push(x);
    }
  }

  const ghDown = results.filter((x) => x.g.status !== 200).length;

  // 已知 jsDelivr 平台策略：可执行类扩展名一律 403（与内容无关，与仓库无关）
  const EXEC_EXT = /\.(bat|cmd|exe|msi|dll|ps1|vbs|jar|apk)$/i;
  const policyExcluded = results.filter((x) => EXEC_EXT.test(x.path) && x.j.status === 403 && x.r.status === 200);

  console.log('--- 非 200 明细（如有）---');
  const realFailures = failures.filter((f) => !policyExcluded.includes(f));
  if (realFailures.length === 0) console.log('（无，全部通过）');
  for (const f of realFailures) {
    console.log(`FAIL [${f.br}] ${f.path}`);
    console.log(`   jsDelivr ${f.j.status}  raw ${f.r.status}  gh ${f.g.status}`);
  }

  if (policyExcluded.length) {
    console.log(`\n--- jsDelivr 平台策略排除（非故障）---`);
    for (const f of policyExcluded) {
      console.log(`[${f.br}] ${f.path}  jsDelivr=403 raw=${f.r.status} gh=${f.g.status}`);
      console.log(`   原因: jsDelivr 屏蔽可执行扩展名；已验证为全局策略（vscode/node/cpython 的 .bat 同为 403）`);
    }
  }

  console.log(`\n--- 汇总 ---`);
  console.log(`文件总数: ${tasks.length}`);
  console.log(`双通道全绿（jsDelivr + raw）: ${ok}`);
  console.log(`策略性排除: ${policyExcluded.length}（不计为故障）`);
  console.log(`真实失败: ${realFailures.length}`);
  console.log(`参考项 gh 页面不可达: ${ghDown}（不计入门禁，见上方口径说明）`);

  // 6. 关键产物内容校验（主链接本体）+ 历史命名兼容性
  const KEY = 'misub/Loyalsoldier_Full_MiSub.ini';
  const LEGACY = 'misub/SubBoost_Full_MiSub.ini';
  console.log(`\n--- 关键产物内容校验: ${KEY} ---`);
  try {
    const rawBase = `https://raw.githubusercontent.com/${OWNER}/${REPO}/dist`;
    const cdnBase = `https://cdn.jsdelivr.net/gh/${OWNER}/${REPO}@dist`;
    const rawTxt = await (await fetch(`${rawBase}/${KEY}`)).text();
    const jdTxt = await (await fetch(`${cdnBase}/${KEY}`)).text();
    const legacyTxt = await (await fetch(`${rawBase}/${LEGACY}`)).text();
    const lines = rawTxt.split(/\r?\n/);
    const count = (re) => lines.filter((l) => re.test(l)).length;
    console.log(`raw 字节: ${Buffer.byteLength(rawTxt, 'utf8')}  md5: ${md5(rawTxt)}`);
    console.log(`CDN 字节: ${Buffer.byteLength(jdTxt, 'utf8')}  md5: ${md5(jdTxt)}`);
    console.log(`双通道一致: ${md5(rawTxt) === md5(jdTxt) ? 'OK' : 'FAIL'}`);
    console.log(`历史命名兼容(${LEGACY}) 一致: ${md5(rawTxt) === md5(legacyTxt) ? 'OK' : 'FAIL'}`);
    console.log(`ruleset= 规则数: ${count(/^ruleset=/)}`);
    console.log(`custom_proxy_group= 组数: ${count(/^custom_proxy_group=/)}`);
    console.log(`[]FINAL 收尾: ${lines.some((l) => /\[\]FINAL/.test(l)) ? '存在 OK' : '缺失 FAIL'}`);
    console.log(`指向 Loyalsoldier 规则集: ${lines.filter((l) => /rules\/clash\//.test(l)).length} 条`);
    console.log(`残留 GEOSITE 内联: ${count(/\[\]GEOSITE/)}（应为 0）`);
  } catch (e) {
    console.log(`校验失败: ${e.message}`);
  }

  // 6.4 聚合版（Agg4）结构与内容校验
  console.log(`\n--- 聚合版 Agg4 结构校验 ---`);
  let aggBad = 0;
  try {
    const rawBase = `https://raw.githubusercontent.com/${OWNER}/${REPO}/dist`;
    const txt = await (await fetch(`${rawBase}/misub/Loyalsoldier_Agg4_MiSub.ini`)).text();
    const ls = txt.split(/\r?\n/);
    const remote = ls.filter((l) => /^ruleset=.*https:\/\//.test(l)).length;
    const aggRefs = ls.filter((l) => /^ruleset=.*rules\/clash\/agg-/.test(l)).length;
    const fin = ls.filter((l) => /^ruleset=.*\[\]FINAL/.test(l)).length;
    const grp = ls.filter((l) => /^custom_proxy_group=/.test(l)).length;
    const chk = (label, got, want) => {
      const ok = got === want;
      if (!ok) aggBad++;
      console.log(`${ok ? 'OK  ' : 'FAIL'} ${label}: ${got}（期望 ${want}）`);
    };
    chk('远程规则集数', remote, 4);
    chk('聚合表引用数', aggRefs, 4);
    chk('FINAL 条数', fin, 1);
    chk('策略组数', grp, 6);

    // manifest 必须声明 4 张聚合表，且 sourceSum - deduped = count
    const man = await (await fetch(`${rawBase}/manifest.json`)).json();
    const aggs = man.aggregates || {};
    const names = Object.keys(aggs).sort();
    console.log(`${names.length === 4 ? 'OK  ' : 'FAIL'} manifest.aggregates: ${names.join(', ') || '(缺)'}`);
    if (names.length !== 4) aggBad++;
    for (const [n, a] of Object.entries(aggs)) {
      const mathOk = a.sourceSum - a.deduped === a.count;
      if (!mathOk) aggBad++;
      console.log(`${mathOk ? 'OK  ' : 'FAIL'} ${n}: ${a.count} 条 <- ${a.sources.join(' + ')}（去重 ${a.deduped}）`);
    }
    const agg4 = man.presets?.Agg4;
    if (!agg4) {
      aggBad++;
      console.log('FAIL manifest 缺少 Agg4 预设');
    } else {
      console.log(`OK   Agg4 providers=${agg4.providers} entries=${agg4.entries}`);
    }
  } catch (e) {
    aggBad++;
    console.log(`校验失败: ${e.message}`);
  }

  // 6.5 README 文档化链接逐条验证（含镜像前缀）
  console.log(`\n--- README 文档链接逐条验证 ---`);
  const DIST = `gh/${OWNER}/${REPO}@dist`;
  const documented = [
    ['主链接·完整版', `https://cdn.jsdelivr.net/${DIST}/misub/Loyalsoldier_Full_MiSub.ini`],
    ['主链接·标准版', `https://cdn.jsdelivr.net/${DIST}/misub/Loyalsoldier_Standard_MiSub.ini`],
    ['主链接·极简版', `https://cdn.jsdelivr.net/${DIST}/misub/Loyalsoldier_Minimal_MiSub.ini`],
    ['远程版·Clash', `https://cdn.jsdelivr.net/${DIST}/misub-remote/Loyalsoldier_Full_MiSub_clash.ini`],
    ['远程版·sing-box', `https://cdn.jsdelivr.net/${DIST}/misub-remote/Loyalsoldier_Full_MiSub_singbox.ini`],
    ['历史·完整版', `https://cdn.jsdelivr.net/${DIST}/misub/SubBoost_Full_MiSub.ini`],
    ['历史·标准版', `https://cdn.jsdelivr.net/${DIST}/misub/SubBoost_Standard_MiSub.ini`],
    ['历史·极简版', `https://cdn.jsdelivr.net/${DIST}/misub/SubBoost_Minimal_MiSub.ini`],
    ['历史·Clash', `https://cdn.jsdelivr.net/${DIST}/misub-remote/SubBoost_Full_MiSub_clash.ini`],
    ['历史·sing-box', `https://cdn.jsdelivr.net/${DIST}/misub-remote/SubBoost_Full_MiSub_singbox.ini`],
    ['聚合版·通用', `https://cdn.jsdelivr.net/${DIST}/misub/Loyalsoldier_Agg4_MiSub.ini`],
    ['聚合版·Clash', `https://cdn.jsdelivr.net/${DIST}/misub-remote/Loyalsoldier_Agg4_MiSub_clash.ini`],
    ['聚合版·sing-box', `https://cdn.jsdelivr.net/${DIST}/misub-remote/Loyalsoldier_Agg4_MiSub_singbox.ini`],
    ['加速版·通用', `https://cdn.jsdelivr.net/${DIST}/misub-fast/Loyalsoldier_Agg4_MiSub.ini`],
    ['加速版·Clash', `https://cdn.jsdelivr.net/${DIST}/misub-remote-fast/Loyalsoldier_Agg4_MiSub_clash.ini`],
    ['加速版·sing-box', `https://cdn.jsdelivr.net/${DIST}/misub-remote-fast/Loyalsoldier_Agg4_MiSub_singbox.ini`],
    ['加速通道·agg-ad', `https://gh-proxy.com/https://raw.githubusercontent.com/${OWNER}/${REPO}/dist/rules/clash/agg-ad.yaml`],
    ['聚合规则集·ad', `https://cdn.jsdelivr.net/${DIST}/rules/clash/agg-ad.yaml`],
    ['聚合规则集·direct', `https://cdn.jsdelivr.net/${DIST}/rules/clash/agg-direct.yaml`],
    ['聚合规则集·singbox', `https://cdn.jsdelivr.net/${DIST}/rules/singbox/agg-direct.json`],
    ['规则集·reject', `https://cdn.jsdelivr.net/${DIST}/rules/clash/reject.yaml`],
    ['规则集·direct', `https://cdn.jsdelivr.net/${DIST}/rules/clash/direct.yaml`],
    ['规则集·cncidr', `https://cdn.jsdelivr.net/${DIST}/rules/clash/cncidr.yaml`],
    ['规则集·singbox reject', `https://cdn.jsdelivr.net/${DIST}/rules/singbox/reject.json`],
    ['镜像·fastly', `https://fastly.jsdelivr.net/${DIST}/misub/Loyalsoldier_Full_MiSub.ini`],
    ['镜像·testingcf', `https://testingcf.jsdelivr.net/${DIST}/misub/Loyalsoldier_Full_MiSub.ini`],
    ['镜像·gcore', `https://gcore.jsdelivr.net/${DIST}/misub/Loyalsoldier_Full_MiSub.ini`],
    ['元信息·manifest', `https://cdn.jsdelivr.net/${DIST}/manifest.json`],
    ['元信息·upstream', `https://cdn.jsdelivr.net/${DIST}/upstream.json`],
    ['徽章 badge', `https://github.com/${OWNER}/${REPO}/actions/workflows/update.yml/badge.svg`],
    ['Actions 页面', `https://github.com/${OWNER}/${REPO}/actions/workflows/update.yml`],
    ['仓库首页', `https://github.com/${OWNER}/${REPO}`],
  ];
  let docBad = 0;
  let docRefDown = 0;
  const docResults = await mapLimit(documented, 4, async ([name, url]) => {
    const res = await head(url, 3);
    return { name, url, ...res };
  });
  for (const d of docResults) {
    const pass = d.status === 200;
    // github.com 的 HTML 页面（仓库首页 / Actions / 徽章）与产物分发无关，
    // 国内直连常需 17–20 秒，超时属网络环境而非链接失效 → 记为参考项。
    const isGhPage = /^https:\/\/github\.com\//.test(d.url);
    if (!pass && isGhPage) {
      docRefDown++;
      console.log(`REF  ${String(d.status).padEnd(3)} ${d.name}（github.com 页面，不计入门禁）`);
      continue;
    }
    if (!pass) docBad++;
    console.log(`${pass ? 'OK  ' : 'FAIL'} ${String(d.status).padEnd(3)} ${d.name}`);
    if (!pass) console.log(`      ${d.url}`);
  }
  const docScored = documented.length - docRefDown;
  console.log(
    `文档链接: ${docScored - docBad}/${docScored} 可用（另有 ${docRefDown} 条 github.com 页面属参考项）`
  );

  // 7. 旧 SHA 复活探测（历史消除验收）
  console.log(`\n--- 历史残留探测（旧 SHA 应全部失效）---`);
  const OLD_SHAS = [
    '7e2da1585e234b1672cfdbcb39d429ff2d784de4',
    'df69af182ef0eb1bd91f60bc10d2afc5c9fa6758',
    'f798a9726afa62c8351f7e21ac25e9dde52cf387',
    '20a5bc992400843b94ae37fcf7b19e33314257a1',
    'dad6023a87b406a6ed11be14225b9b5ea7979932',
  ];
  let revived = 0;
  for (const sha of OLD_SHAS) {
    const [a, r, j] = await Promise.all([
      head(`https://api.github.com/repos/${OWNER}/${REPO}/commits/${sha}`, 1),
      head(`https://raw.githubusercontent.com/${OWNER}/${REPO}/${sha}/README.md`, 2),
      head(`https://cdn.jsdelivr.net/gh/${OWNER}/${REPO}@${sha}/README.md`, 2),
    ]);
    // 只有「真的能拿到内容」才算复活。status 0 是请求异常（超时 / 连接重置），
    // 此时用户同样取不到文件，按失效处理；否则每次网络抖动都会误报 ALIVE。
    const revivedHit = r.status === 200 || j.status === 200;
    const dead = !revivedHit;
    if (!dead) revived++;
    console.log(`${dead ? 'DEAD  ' : 'ALIVE!'} ${sha.slice(0, 10)}  API=${a.status} raw=${r.status} jsDelivr=${j.status}`);
  }
  console.log(`复活数量: ${revived} ${revived === 0 ? '(历史消除有效)' : '(存在残留，需处理)'}`);

  console.log(`\n=== 体检结束 ===\n`);
  process.exit(realFailures.length === 0 && revived === 0 && docBad === 0 && aggBad === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('FATAL', e);
  process.exit(2);
});
