@echo off
setlocal
cd /d "%~dp0.."
if not exist data mkdir data
set NODE_ENV=production
set AURORA_AUTO_OPEN=false
rem All AURORA data lives under AURORA_HOME (a per-machine user env var, e.g.
rem D:\Claude\AURORA\userdata) — the one canonical database + content dir no
rem matter which way AURORA is launched (see server/paths.ts). Defaults to this
rem project's own userdata folder if the env var isn't set.
if not defined AURORA_HOME set AURORA_HOME=%CD%\userdata
if not defined HF_HOME set HF_HOME=%AURORA_HOME%\hf-cache
echo ---- %date% %time% starting AURORA ---- >> data\aurora-server.log
node dist\index.js >> data\aurora-server.log 2>&1
