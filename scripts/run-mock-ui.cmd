@echo off
cd /d "%~dp0.."
"C:\Program Files\nodejs\node.exe" "scripts\mock-ui-server.js" > "output\mock-ui.out.log" 2> "output\mock-ui.err.log"
