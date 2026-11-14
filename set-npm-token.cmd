@echo off
chcp 65001 >nul
echo ============================================
echo   Set npm publish token for registry.npmjs.org
echo   (paste the granular token that starts with npm_)
echo ============================================
echo.
set /p TOKEN=Paste token here and press Enter: 
if "%TOKEN%"=="" (
  echo No token entered. Nothing changed.
  pause
  exit /b 1
)
"C:\Program Files\nodejs\npm.cmd" config set "//registry.npmjs.org/:_authToken=%TOKEN%" --location=user
if errorlevel 1 (
  echo.
  echo FAILED. Check that the token is correct.
) else (
  echo.
  echo OK - token stored in %%USERPROFILE%%\.npmrc
)
echo.
pause
