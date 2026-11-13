@echo off
rem Universal Harness — Windows desktop launcher (v1.0.0).
rem Double-clickable: starts the node server from this USB/Desktop folder and
rem prints the LAN address + pairing info. No global Node/npm required: the
rem bundled runtime under runtime\node\win-x64 is used when present, otherwise
rem the launcher falls back to whatever `node` is on PATH and prints a hint.
setlocal EnableExtensions
title Universal Harness v1.0.0

set "ROOT=%~dp0..\.."
if not exist "%ROOT%\bin\uh.mjs" set "ROOT=%~dp0."
if exist "%ROOT%\UniversalHarness" set "ROOT=%ROOT%\UniversalHarness"
set "UH_ROOT=%ROOT%"

rem Locate the bundled node runtime (runtime\node\win-x64\**\node.exe).
set "NODE_EXE="
for /r "%ROOT%\runtime\node\win-x64" %%n in (node.exe) do (
  if not defined NODE_EXE set "NODE_EXE=%%n"
)
if not defined NODE_EXE (
  where node >nul 2>nul && set "NODE_EXE=node"
)
if not defined NODE_EXE (
  echo [Universal Harness] No bundled Node runtime found and no system node on PATH.
  echo Run UniversalHarness.cmd ^(setup^) first, or install the runtime via "uh setup".
  pause
  exit /b 1
)

rem Show the LAN addresses the controllers can target.
echo.
echo ============ Universal Harness v1.0.0 ============
echo Root:     %ROOT%
for /f "tokens=2 delims=:" %%a in ('ipconfig ^| findstr /c:"IPv4"') do (
  for /f "tokens=* delims= " %%b in ("%%a") do echo LAN:      https://%%b:7437
)
echo Pairing:  in a second terminal run  ^"%ROOT%\bin\UniversalHarness.cmd^" pair --endpoint https://^<lan-ip^>:7437
echo         ^(or press the Pair button in the Universal Harness Android app, LAN Remote mode^)
echo ==================================================
echo.

"%NODE_EXE%" "%ROOT%\bin\uh.mjs" serve --listen tls://0.0.0.0:7437
pause
