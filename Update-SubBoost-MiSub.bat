@echo off
chcp 65001 >nul
setlocal

rem ===========================================================================
rem  Update-SubBoost-MiSub.bat
rem  SPDX-License-Identifier: AGPL-3.0-only
rem  Copyright (C) 2026 n2far2000 <n2far2000@users.noreply.github.com>
rem
rem  Windows 启动器：拉取 SubBoost 上游预设规则，重新生成本地 MiSub 规则模板。
rem  等价于手动执行： node scripts\subboost2misub.mjs --verify --diff
rem
rem  依赖：Node.js 18 或更高版本（生成器零外部依赖，无需 npm install）
rem
rem  用法（参数原样透传给生成器，完整参数表见 README）：
rem    Update-SubBoost-MiSub.bat                              生成完整版（默认）
rem    Update-SubBoost-MiSub.bat --preset standard            生成标准版
rem    Update-SubBoost-MiSub.bat --all-nodes                  策略组内展开全部节点
rem    Update-SubBoost-MiSub.bat --offline                    只用本地缓存，不联网
rem    Update-SubBoost-MiSub.bat --dist dist --all-presets    生成完整产物目录
rem ===========================================================================

set "HERE=%~dp0"
set "GEN=%HERE%scripts\subboost2misub.mjs"

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
echo [INFO] 正在拉取上游规则定义并生成模板；首次运行需下载 geodata，可能耗时 1-3 分钟。
echo.

node "%GEN%" --verify --diff %*
if errorlevel 1 (
    echo.
    echo [ERROR] 生成失败，请根据上方输出定位原因。
    exit /b 1
)

echo.
echo [OK] 完成。
echo      本地模式输出：%HERE%SubBoost_*_MiSub.ini
echo      产物模式输出：%HERE%dist\
echo.
pause
