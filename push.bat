@echo off
cd /d "%~dp0"

echo ================================
echo   당동 앱 - GitHub 푸시
echo ================================
echo.

git status --short
echo.

set /p MSG=커밋 메시지 입력 (그냥 엔터 치면 자동 메시지): 
if "%MSG%"=="" set MSG=Update %date% %time:~0,5%

git add -A
git commit -m "%MSG%"
git push origin main

echo.
echo ================================
echo   완료! 1분 안에 앱에 반영됩니다.
echo ================================
pause