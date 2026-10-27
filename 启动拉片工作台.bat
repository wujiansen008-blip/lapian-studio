@echo off
chcp 65001 >nul
set ELECTRON_RUN_AS_NODE=
set NODE_OPTIONS=
cd /d "%~dp0"
echo 正在启动拉片工作台...
if not exist node_modules (
  echo 首次运行，正在安装依赖，请耐心等待...
  call npm install
)
call npm start
if errorlevel 1 pause
