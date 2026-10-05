@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo 正在启动 Miro...
call npm.cmd start
if errorlevel 1 (
  echo Miro 启动异常。请检查上方提示。
  pause
)
