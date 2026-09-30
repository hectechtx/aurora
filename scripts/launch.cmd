@echo off
setlocal
cd /d "%~dp0.."
if not exist data mkdir data
set NODE_ENV=production
set AURORA_AUTO_OPEN=false
rem All AURORA data lives on the F drive (owner's preference — keep everything
rem off the system drive). This is the one canonical database + content dir no
rem matter which way AURORA is launched. The Electron app is pointed at the
rem same folder (see electron/main.ts). Big model caches are redirected to F
rem too (HuggingFace + Ollama) so nothing large lands on C:.
set AURORA_DATA_DIR=F:\Claude\AURORA\userdata
set HF_HOME=F:\Claude\AURORA\userdata\hf-cache
echo ---- %date% %time% starting AURORA ---- >> data\aurora-server.log
node dist\index.js >> data\aurora-server.log 2>&1
