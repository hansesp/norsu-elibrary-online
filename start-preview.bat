@echo off
title NORSU E-Library (preview)
cd /d "%~dp0"
echo Starting a local preview of the website...
echo When it says "running at http://localhost:5500" your browser will open.
echo Leave this window open while you test. Close it to stop.
echo.
start "" cmd /c "ping -n 3 127.0.0.1 >nul & start http://localhost:5500"
node preview-server.js
echo.
echo The preview stopped. If you saw an error above, copy it so it can be fixed.
pause
