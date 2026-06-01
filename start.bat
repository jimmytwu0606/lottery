@echo off
chcp 65001 >nul
echo 啟動台灣彩券分析工具...

set CHROME1=C:\Program Files\Google\Chrome\Application\chrome.exe
set CHROME2=C:\Program Files (x86)\Google\Chrome\Application\chrome.exe
set TMPDIR=%TEMP%\lottery_browser

if exist "%CHROME1%" (
  start "" "%CHROME1%" --allow-file-access-from-files --user-data-dir="%TMPDIR%" "%~dp0index.html"
) else if exist "%CHROME2%" (
  start "" "%CHROME2%" --allow-file-access-from-files --user-data-dir="%TMPDIR%" "%~dp0index.html"
) else (
  echo 找不到 Chrome，嘗試用預設瀏覽器開啟...
  start "" "%~dp0index.html"
)
