@echo off
cd /d "%~dp0"

echo ================================
echo   당동 테스트(beta) 배포
echo ================================
echo.

git remote get-url beta >nul 2>&1
if errorlevel 1 (
  echo [!] 'beta' 원격이 아직 없습니다. 저장소를 만든 뒤 한 번만 실행하세요:
  echo     git remote add beta https://github.com/sj3355455/Dangdong-beta.git
  echo.
  pause
  exit /b 1
)

git status --short
echo.

set /p MSG=커밋 메시지 (엔터=자동):
if "%MSG%"=="" set MSG=beta test %date% %time:~0,5%

git add -A
git commit -m "%MSG%"

echo.
echo 테스트 저장소(main)로 강제 푸시합니다...
git push -f beta HEAD:main

echo.
echo ================================
echo   완료! 잠시 후 테스트 앱에 반영됩니다:
echo   https://sj3355455.github.io/Dangdong-beta/
echo.
echo   본 앱으로 승격하려면: 본앱.bat 실행 (origin/main)
echo ================================
pause
