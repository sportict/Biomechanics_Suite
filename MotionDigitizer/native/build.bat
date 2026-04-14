cd /d "D:\Program Files\Microsoft Visual Studio\2022\Community\Common7\Tools"
call VsDevCmd.bat -arch=x64
cd /d "e:\GoogleDrive\pro\Electoron\Biomechanics_Suite\MotionDigitizer\native"
msbuild binding.sln /p:Configuration=Default /p:Platform=x64
