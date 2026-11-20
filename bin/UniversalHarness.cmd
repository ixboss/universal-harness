@echo off
REM UniversalHarness — Windows launcher shim (no global Node required).
REM
REM Locates the bundled Node runtime pinned in manifests\runtime.manifest.json
REM and executes bin\uh.mjs with it. The shim itself contains no logic beyond
REM resolution so the shipped tree stays auditable.

setlocal enabledelayedexpansion

REM Determine the directory this shim lives in (works when launched from any cwd).
set "SHIM_DIR=%~dp0"
if "%SHIM_DIR:~-1%"=="\" set "SHIM_DIR=%SHIM_DIR:~0,-1%"

REM Prefer an explicit override.
if defined UH_ROOT set "ROOT=%UH_ROOT%" & goto :found

set "ROOT=%SHIM_DIR%"
:found

REM Resolve the runtime dir by glob, not a hardcoded version: the manifest is the
REM pin source, and a manifest bump must not silently brick every launcher.
set "NODE_EXE="
for /d %%D in ("%ROOT%\runtime\node\win-x64\node-v*-win-x64") do set "NODE_EXE=%%D\node.exe"

if not exist "%NODE_EXE%" (
  echo RUNTIME_MISSING: bundled Node runtime not found at "%NODE_EXE%".
  echo Action: run setup on a machine with network access ^(e.g. UniversalHarness setup^),
  echo or copy the runtime\ directory from a prepared installation.
  exit /b 11
)

"%NODE_EXE%" "%ROOT%\bin\uh.mjs" %*
exit /b %ERRORLEVEL%
