@echo off
chcp 65001 >nul
cd /d "%~dp0"
where python >nul 2>nul
if errorlevel 1 (
  echo 需要先安装 Python 3：https://www.python.org/downloads/
  echo 安装时记得勾选 "Add Python to PATH"
  pause
  exit /b 1
)
python serve.py
pause
