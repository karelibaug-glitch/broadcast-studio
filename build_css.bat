@echo off
echo ===================================================
echo Compiling Standalone Offline Tailwind CSS...
echo ===================================================
npx -y tailwindcss@3 -i ./css/input.css -o ./css/tailwind.min.css --minify
copy /Y css\tailwind.min.css python_app\static\css\tailwind.min.css
echo.
echo [DONE] Tailwind CSS rebuilt successfully into css/tailwind.min.css!
pause
