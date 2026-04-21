@echo off
setlocal EnableDelayedExpansion

echo ============================================================
echo  AI Vision Platform - Windows EXE Build Script
echo ============================================================

:: Resolve repo root (two levels up from deploy\exe)
set "DEPLOY_DIR=%~dp0"
pushd "%~dp0..\.."
set "REPO_ROOT=%CD%"
popd

echo [DEBUG] DEPLOY_DIR = %DEPLOY_DIR%
echo [DEBUG] REPO_ROOT  = %REPO_ROOT%

:: --------------------------------------------------------------------------
:: Step 1 - Check Python
:: --------------------------------------------------------------------------
echo.
echo [1/6] Checking Python...
python --version >nul 2>&1
if errorlevel 1 (
    echo [ERROR] Python not found. Install Python 3.11 from https://www.python.org/downloads/
    exit /b 1
)
python --version

:: --------------------------------------------------------------------------
:: Step 2 - Check Node
:: --------------------------------------------------------------------------
echo.
echo [2/6] Checking Node.js / npm...
node --version >nul 2>&1
if errorlevel 1 (
    echo [ERROR] Node.js not found. Install from https://nodejs.org/
    exit /b 1
)
node --version
call npm --version

:: --------------------------------------------------------------------------
:: Step 3 - Build React frontend
:: --------------------------------------------------------------------------
echo.
echo [3/6] Building React frontend...
cd /d "%REPO_ROOT%\frontend"

if not exist node_modules (
    echo      Installing npm packages...
    call npm install --legacy-peer-deps
    if errorlevel 1 ( echo [ERROR] npm install failed. & exit /b 1 )
)

set REACT_APP_API_URL=http://localhost:8000/api/v1
set REACT_APP_BASE_URL=http://localhost:8000
call npm run build
if errorlevel 1 ( echo [ERROR] React build failed. & exit /b 1 )
echo      Frontend built successfully.

:: --------------------------------------------------------------------------
:: Step 4 - Install Python build dependencies
:: --------------------------------------------------------------------------
echo.
echo [4/6] Installing Python build dependencies...
cd /d "%REPO_ROOT%"
pip install pyinstaller ^
    fastapi uvicorn[standard] sqlalchemy[asyncio] asyncpg psycopg2-binary ^
    celery[redis] redis transformers sentencepiece protobuf ultralytics ^
    Pillow supervision opencv-python-headless pyyaml python-dotenv ^
    pydantic pydantic-settings passlib[bcrypt] python-jose[cryptography] ^
    python-multipart websockets loguru
if errorlevel 1 ( echo [ERROR] pip install failed. & exit /b 1 )

:: --------------------------------------------------------------------------
:: Step 5 - Check for portable binaries
:: --------------------------------------------------------------------------
echo.
echo [5/6] Checking portable service binaries...
echo [DEBUG] Checking PG path: %DEPLOY_DIR%resources\postgres\bin\pg_ctl.exe

if not exist "%DEPLOY_DIR%resources\postgres\bin\pg_ctl.exe" (
    echo.
    echo [WARNING] Portable PostgreSQL NOT found at:
    echo          %DEPLOY_DIR%resources\postgres\bin\pg_ctl.exe
    echo.
    echo   Download portable PostgreSQL 17 for Windows from:
    echo   https://www.enterprisedb.com/download-postgresql-binaries
    echo   Extract to: deploy\exe\resources\postgres\
    echo   (the bin\ folder must be directly inside postgres\)
    echo.
    set /p CONTINUE="Continue build without PostgreSQL binaries? [y/N]: "
    if /i "!CONTINUE!" neq "y" exit /b 1
) else (
    echo      PostgreSQL binaries found.
)

if not exist "%DEPLOY_DIR%resources\redis\redis-server.exe" (
    echo.
    echo [WARNING] Portable Redis NOT found at:
    echo          %DEPLOY_DIR%resources\redis\redis-server.exe
    echo.
    echo   Download Redis for Windows from:
    echo   https://github.com/microsoftarchive/redis/releases
    echo   OR use Memurai: https://www.memurai.com/get-memurai
    echo   Extract to: deploy\exe\resources\redis\
    echo.
    set /p CONTINUE="Continue build without Redis binary? [y/N]: "
    if /i "!CONTINUE!" neq "y" exit /b 1
) else (
    echo      Redis binary found.
)

:: --------------------------------------------------------------------------
:: Step 6 - Run PyInstaller
:: --------------------------------------------------------------------------
echo.
echo [6/6] Running PyInstaller...
cd /d "%DEPLOY_DIR%"
python -m PyInstaller launcher.spec --clean --noconfirm
if errorlevel 1 ( echo [ERROR] PyInstaller failed. & exit /b 1 )

:: --------------------------------------------------------------------------
:: Done
:: --------------------------------------------------------------------------
echo.
echo ============================================================
echo  BUILD COMPLETE
echo  Output: %DEPLOY_DIR%dist\AIVision\aivision.exe
echo ============================================================
echo.
echo To run:
echo   cd dist\AIVision
echo   aivision.exe
echo.
echo On first launch, the app will:
echo   - Initialize the PostgreSQL database
echo   - Start all services
echo   - Open your browser at http://localhost:8000

endlocal
