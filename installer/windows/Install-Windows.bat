@echo off
chcp 65001 >nul
setlocal
title Sayframe для After Effects — установка

set "SRC=%~dp0Sayframe"
set "EXTDIR=%APPDATA%\Adobe\CEP\extensions"
set "DEST=%EXTDIR%\Sayframe"
set "OLD=%EXTDIR%\ClaudePanel"

echo Sayframe для After Effects — установка
echo --------------------------------------
echo.

if not exist "%SRC%\CSXS\manifest.xml" (
    echo Не найдена папка Sayframe рядом с установщиком.
    echo Распакуйте архив целиком и запустите установщик из распакованной папки.
    echo.
    pause
    exit /b 1
)

echo Что сделает установщик:
echo   1. Скопирует панель в папку:
echo      %DEST%
echo   2. Разрешит After Effects загружать панели без подписи Adobe
echo      (настройка PlayerDebugMode в реестре текущего пользователя).
echo.
echo Нажмите любую клавишу, чтобы установить, или закройте окно для отмены.
pause >nul
echo.

if not exist "%EXTDIR%" mkdir "%EXTDIR%"
if exist "%DEST%" rmdir /s /q "%DEST%"
if exist "%OLD%" rmdir /s /q "%OLD%"
xcopy "%SRC%" "%DEST%\" /e /i /q /y >nul
if errorlevel 1 (
    echo Не удалось скопировать панель в %DEST%
    echo.
    pause
    exit /b 1
)
echo Панель скопирована.

for %%v in (9 10 11 12 13 14 15 16) do (
    reg add "HKCU\Software\Adobe\CSXS.%%v" /v PlayerDebugMode /t REG_SZ /d 1 /f >nul
)
echo Настройка включена.
echo.
echo Готово. Если After Effects открыт, сохраните проект и перезапустите программу.
echo Панель находится в меню: Window ^> Extensions ^> Sayframe
echo.
echo Для референсов и вставки картинок включите в After Effects:
echo Edit ^> Preferences ^> Scripting ^& Expressions ^> Allow Scripts to Write Files and Access Network
echo.
pause
exit /b 0
