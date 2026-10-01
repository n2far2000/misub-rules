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
    const [j, r, g] = await Promise.all([head(t.jsdelivr), head(t.raw), head(t.gh)]);
    return { ...t, j, r, g };
  });

  // 5. 统计
  let ok = 0, bad = 0;
  const failures = [];
  for (const x of results) {
    const pass = x.j.status === 200 && x.r.status === 200 && x.g.status === 200;
    if (pass) ok++;
    else {
      bad++;
      failures.push(x);
    }
  }

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
  console.log(`三通道全绿: ${ok}`);
  console.log(`策略性排除: ${policyExcluded.length}（不计为故障）`);
  console.log(`真实失败: ${realFailures.length}`);

  // 6. 关键产物内容校验（主链接本体）
  const KEY = 'misub/SubBoost_Full_MiSub.ini';
  console.log(`\n--- 关键产物内容校验: ${KEY} ---`);
  try {
    const rawTxt = await (await fetch(`https://raw.githubusercontent.com/${OWNER}/${REPO}/dist/${KEY}`)).text();
    const jdTxt = await (await fetch(`https://cdn.jsdelivr.net/gh/${OWNER}/${REPO}@dist/${KEY}`)).text();
    const lines = rawTxt.split(/\r?\n/);
    const count = (re) => lines.filter((l) => re.test(l)).length;
    console.log(`raw 字节: ${Buffer.byteLength(rawTxt, 'utf8')}  md5: ${md5(rawTxt)}`);
    console.log(`CDN 字节: ${Buffer.byteLength(jdTxt, 'utf8')}  md5: ${md5(jdTxt)}`);
    console.log(`双通道一致: ${md5(rawTxt) === md5(jdTxt) ? 'OK' : 'FAIL'}`);
    console.log(`ruleset= 规则数: ${count(/^ruleset=/)}`);
    console.log(`custom_proxy_group= 组数: ${count(/^custom_proxy_group=/)}`);
    console.log(`[]FINAL 收尾: ${lines.some((l) => /\[\]FINAL/.test(l)) ? '存在 OK' : '缺失 FAIL'}`);
    console.log(`空成员组: ${count(/^custom_proxy_group=[^`]*``$|^custom_proxy_group=.*``\s*$/)}`);
  } catch (e) {
    console.log(`校验失败: ${e.message}`);
  }

  // 6.5 README 文档化链接逐条验证（含镜像前缀）
  console.log(`\n--- README 文档链接逐条验证 ---`);
  const DIST = `gh/${OWNER}/${REPO}@dist`;
  const documented = [
    ['主链接·完整版', `https://cdn.jsdelivr.net/${DIST}/misub/SubBoost_Full_MiSub.ini`],
    ['主链接·标准版', `https://cdn.jsdelivr.net/${DIST}/misub/SubBoost_Standard_MiSub.ini`],
    ['主链接·精简版', `https://cdn.jsdelivr.net/${DIST}/misub/SubBoost_Minimal_MiSub.ini`],
    ['远程版·Clash', `https://cdn.jsdelivr.net/${DIST}/misub-remote/SubBoost_Full_MiSub_clash.ini`],
    ['远程版·sing-box', `https://cdn.jsdelivr.net/${DIST}/misub-remote/SubBoost_Full_MiSub_singbox.ini`],
    ['镜像·fastly', `https://fastly.jsdelivr.net/${DIST}/misub/SubBoost_Full_MiSub.ini`],
    ['镜像·testingcf', `https://testingcf.jsdelivr.net/${DIST}/misub/SubBoost_Full_MiSub.ini`],
    ['镜像·gcore', `https://gcore.jsdelivr.net/${DIST}/misub/SubBoost_Full_MiSub.ini`],
    ['元信息·manifest', `https://cdn.jsdelivr.net/${DIST}/manifest.json`],
    ['元信息·upstream', `https://cdn.jsdelivr.net/${DIST}/upstream.json`],
    ['徽章 badge', `https://github.com/${OWNER}/${REPO}/actions/workflows/update.yml/badge.svg`],
    ['Actions 页面', `https://github.com/${OWNER}/${REPO}/actions/workflows/update.yml`],
    ['仓库首页', `https://github.com/${OWNER}/${REPO}`],
  ];
  let docBad = 0;
  const docResults = await mapLimit(documented, 4, async ([name, url]) => {
    const res = await head(url, 3);
    return { name, url, ...res };
  });
  for (const d of docResults) {
    const pass = d.status === 200;
    if (!pass) docBad++;
    console.log(`${pass ? 'OK  ' : 'FAIL'} ${String(d.status).padEnd(3)} ${d.name}`);
    if (!pass) console.log(`      ${d.url}`);
  }
  console.log(`文档链接: ${documented.length - docBad}/${documented.length} 可用`);

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
      head(`https://raw.githubusercontent.com/${OWNER}/${REPO}/${sha}/README.md`, 1),
      head(`https://cdn.jsdelivr.net/gh/${OWNER}/${REPO}@${sha}/README.md`, 1),
    ]);
    const dead = r.status === 404 && j.status === 404;
    if (!dead) revived++;
    console.log(`${dead ? 'DEAD  ' : 'ALIVE!'} ${sha.slice(0, 10)}  API=${a.status} raw=${r.status} jsDelivr=${j.status}`);
  }
  console.log(`复活数量: ${revived} ${revived === 0 ? '(历史消除有效)' : '(存在残留，需处理)'}`);

  console.log(`\n=== 体检结束 ===\n`);
  process.exit(realFailures.length === 0 && revived === 0 && docBad === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('FATAL', e);
  process.exit(2);
});
