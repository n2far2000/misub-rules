@echo off
chcp 65001 >nul
setlocal

rem ===========================================================================
rem  Update-MiSub-Rules.bat
rem  SPDX-License-Identifier: AGPL-3.0-only
rem  Copyright (C) 2026 n2far2000 <n2far2000@users.noreply.github.com>
rem
rem  Windows 启动器：拉取 Loyalsoldier/clash-rules 上游规则集，重新生成本地
rem  MiSub 规则模板（白名单模式）。
rem  等价于手动执行： node scripts\loyalsoldier2misub.mjs --verify --out-dir output
rem
rem  依赖：Node.js 18 或更高版本（生成器零外部依赖，无需 npm install）
rem
rem  用法（参数原样透传给生成器，完整参数表见 README）：
rem    Update-MiSub-Rules.bat                       生成全部三档预设到 output\
rem    Update-MiSub-Rules.bat --preset Full         只生成完整版
rem    Update-MiSub-Rules.bat --offline             只用本地缓存，不联网
rem    Update-MiSub-Rules.bat --dist dist           生成完整产物目录（含远程规则集）
rem ===========================================================================

set "HERE=%~dp0"
set "GEN=%HERE%scripts\loyalsoldier2misub.mjs"

if not exist "%GEN%" (
    echo [ERROR] 未找到生成器脚本：
    echo         %GEN%
    echo         请在仓库根目录下运行本脚本。
    exit /b 1
)

where node >nul 2>nul
if errorlevel 1 (
    echo [ERROR] 未在 PATH 中找到 node.exe。
    echo         请先安装 Node.js 18 或更高版本：https://nodejs.org/
    exit /b 1
)

for /f "delims=" %%v in ('node -v 2^>nul') do set "NODE_VERSION=%%v"
echo [INFO] Node.js %NODE_VERSION%
echo [INFO] 正在拉取上游规则集并生成模板；首次运行需下载约 9 MB 规则数据。
echo.

rem 未显式给出输出位置时，落到 output\ 目录，避免污染仓库根目录
set "ARGS=%*"
echo %ARGS% | findstr /C:"--dist" /C:"--out" >nul
if errorlevel 1 (
    node "%GEN%" --verify --out-dir "%HERE%output" %*
) else (
    node "%GEN%" --verify %*
)
if errorlevel 1 (
    echo.
    echo [ERROR] 生成失败，请根据上方输出定位原因。
    exit /b 1
)

echo.
echo [OK] 完成。
echo      默认输出：%HERE%output\misub-remote\
echo      产物模式：%HERE%dist\
echo.
pause
