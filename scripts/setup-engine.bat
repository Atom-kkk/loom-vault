@echo off
REM ============================================================
REM Loom 织造所 · 本地引擎一键安装脚本（Windows）
REM 别人 clone 项目后，跑一次这个脚本，自动装好 ComfyUI 引擎。
REM
REM 用法：双击 scripts\setup-engine.bat
REM ============================================================
chcp 65001 >nul
setlocal

cd /d "%~dp0\.."
set "ROOT=%CD%"
set "ENGINE_DIR=%ROOT%\engine"

echo [Loom] 本地引擎安装器
echo [Loom] 工作目录：%ROOT%

REM ---- 1. 检查 Python ----
where python >nul 2>nul
if errorlevel 1 (
  echo [Loom][错误] 没找到 Python。请先安装 Python 3：
  echo          https://www.python.org/downloads/
  echo          安装时记得勾选 "Add Python to PATH"
  pause
  exit /b 1
)
echo [Loom] Python：已就绪

REM ---- 2. 安装 comfy-cli ----
where comfy >nul 2>nul
if errorlevel 1 (
  echo [Loom] 未检测到 comfy-cli，正在安装（ComfyUI 官方命令行工具）…
  python -m pip install --user comfy-cli
  if errorlevel 1 (
    echo [Loom][错误] comfy-cli 安装失败，请手动执行：pip install comfy-cli
    pause
    exit /b 1
  )
)
echo [Loom] comfy-cli：已就绪

REM ---- 3. 安装引擎 ----
if exist "%ENGINE_DIR%\main.py" (
  echo [Loom] 检测到 engine\ 已有引擎，跳过安装
  goto :config
)
if exist "%ENGINE_DIR%\ComfyUI\main.py" (
  echo [Loom] 检测到 engine\ 已有引擎，跳过安装
  goto :config
)

echo [Loom] 开始安装 ComfyUI 引擎到 engine\（首次需下载几个 GB，约 10~30 分钟）…
if not exist "%ENGINE_DIR%" mkdir "%ENGINE_DIR%"
comfy --workspace="%ENGINE_DIR%" install --fast-deps
if errorlevel 1 (
  echo [Loom][错误] 引擎安装失败，请重试或手动执行：comfy install
  pause
  exit /b 1
)
echo [Loom] 引擎安装完成

:config
REM ---- 4. 定位 main.py 并写配置 ----
set "MAIN="
if exist "%ENGINE_DIR%\main.py" set "MAIN=%ENGINE_DIR%\main.py"
if exist "%ENGINE_DIR%\ComfyUI\main.py" set "MAIN=%ENGINE_DIR%\ComfyUI\main.py"

if "%MAIN%"=="" (
  echo [Loom][提示] 没找到 main.py，请在 Loom 设置里手动填 ComfyUI 目录。
  goto :done
)

for %%f in ("%MAIN%") do set "COMFY_DIR=%%~dpf"
set "COMFY_DIR=%COMFY_DIR:~0,-1%"

echo [Loom] 找到引擎目录：%COMFY_DIR%
(
  echo {
  echo   "comfy_dir": "%COMFY_DIR:\=/%",
  echo   "port": 8188
  echo }
) > "%ROOT%\.engine.json"
echo [Loom] 已写入 .engine.json

:done
echo.
echo [Loom] 全部完成！现在双击 start.bat 打开 Loom，点「生成」即可自动拉起引擎出图。
echo [Loom] 提示：出图还需要模型文件，放到 ComfyUI 的 models\ 目录，或在 Loom「画布 → 高级选项」里指定路径。
pause
