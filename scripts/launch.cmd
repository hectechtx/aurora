@echo off
setlocal
cd /d "%~dp0.."
if not exist data mkdir data
set NODE_ENV=production
set AURORA_AUTO_OPEN=false
echo ---- %date% %time% starting AURORA ---- >> data\aurora-server.log
node dist\index.js >> data\aurora-server.log 2>&1
