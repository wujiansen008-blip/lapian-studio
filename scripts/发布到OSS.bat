@echo off
chcp 65001 >nul
cd /d "%~dp0.."
set PYTHONPATH=%CD%\scripts\pylib

echo ===============================================
echo    发布最新版本到阿里云 OSS
echo ===============================================
echo.

where python >nul 2>nul
if %errorlevel%==0 (
    python scripts\publish-oss.py %*
) else (
    py scripts\publish-oss.py %*
)

echo.
pause
