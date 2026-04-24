@echo off
setlocal EnableDelayedExpansion

echo ============================================================
echo  AI Vision Platform - Distribution Package Creator
echo ============================================================

:: Default paths — override via arguments:
::   package.bat [dist-folder] [output-folder]
::   e.g.  package.bat "D:\AIVision-App\AIVision" "C:\Users\me\Desktop"
set "DIST_DIR=D:\AIVision-App\AIVision"
set "OUTPUT_DIR=D:\AIVision-App"

if not "%~1"=="" set "DIST_DIR=%~1"
if not "%~2"=="" set "OUTPUT_DIR=%~2"

:: --------------------------------------------------------------------------
:: Validate that the build exists
:: --------------------------------------------------------------------------
if not exist "%DIST_DIR%\aivision.exe" (
    echo.
    echo [ERROR] aivision.exe not found at:
    echo         %DIST_DIR%\aivision.exe
    echo.
    echo         Run build.bat first to produce the executable.
    exit /b 1
)

:: --------------------------------------------------------------------------
:: Build a datestamped filename using PowerShell (avoids locale issues)
:: --------------------------------------------------------------------------
for /f "delims=" %%D in ('powershell -NoProfile -Command "Get-Date -Format yyyy-MM-dd"') do set "DATE_TAG=%%D"
set "ZIP_NAME=AIVision-win64-%DATE_TAG%.zip"
set "ZIP_PATH=%OUTPUT_DIR%\%ZIP_NAME%"

echo.
echo Source folder : %DIST_DIR%
echo Output ZIP    : %ZIP_PATH%
echo.

:: Remove stale zip if present
if exist "%ZIP_PATH%" (
    echo [INFO] Removing previous %ZIP_NAME%...
    del /f "%ZIP_PATH%"
)

:: --------------------------------------------------------------------------
:: Step 1 — Create the ZIP
:: --------------------------------------------------------------------------
echo [1/2] Compressing AIVision folder (this may take a few minutes)...

powershell -NoProfile -Command ^
    "Compress-Archive -Path '%DIST_DIR%' -DestinationPath '%ZIP_PATH%' -CompressionLevel Optimal"

if errorlevel 1 (
    echo.
    echo [ERROR] Compress-Archive failed.
    echo         Make sure PowerShell 5+ is available and the output path is writable.
    exit /b 1
)

:: --------------------------------------------------------------------------
:: Step 2 — Report size and instructions
:: --------------------------------------------------------------------------
echo [2/2] Verifying archive...

for %%A in ("%ZIP_PATH%") do (
    set "ZIP_BYTES=%%~zA"
)
set /a "ZIP_MB=%ZIP_BYTES% / 1048576"

echo.
echo ============================================================
echo  PACKAGE READY
echo.
echo  File : %ZIP_PATH%
echo  Size : ~%ZIP_MB% MB
echo ============================================================
echo.
echo ---- Instructions for the end user --------------------------
echo.
echo  1. Send them: %ZIP_NAME%
echo.
echo  2. They should:
echo       a. Extract the ZIP to any folder
echo            e.g. right-click > Extract All... > C:\AIVision
echo.
echo       b. Open the extracted AIVision\ folder
echo.
echo       c. Double-click  aivision.exe
echo            (or right-click > Run as administrator if UAC blocks it)
echo.
echo       d. Wait ~30-60 seconds on first launch
echo            The app initialises the database automatically.
echo.
echo       e. A browser tab opens at http://localhost:8000
echo.
echo  NO installation required — no Python, no Node, no database setup.
echo  Everything is bundled inside the ZIP.
echo.
echo  System requirements for the end user:
echo    - Windows 10/11 (64-bit)
echo    - NVIDIA GPU with CUDA 12.x drivers (for AI inference)
echo    - 8 GB RAM minimum (16 GB recommended)
echo    - 10 GB free disk space for the app + AI model weights
echo -------------------------------------------------------------

endlocal
