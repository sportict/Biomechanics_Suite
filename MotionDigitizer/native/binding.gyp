{
  "targets": [
    {
      "target_name": "opencv_module",
      "sources": [ "opencv_module.cpp" ],
      "include_dirs": [
        "<!@(node -p \"require('node-addon-api').include\")"
      ],
      "cflags!": [ "-fno-exceptions", "-fno-rtti" ],
      "cflags_cc!": [ "-fno-exceptions", "-fno-rtti" ],
      "defines": [ "NAPI_DISABLE_CPP_EXCEPTIONS" ],
      "conditions": [
        ["OS=='win'", {
          "include_dirs": [
            "C:/vcpkg/installed/x64-windows/include/opencv4"
          ],
          "libraries": [
            "C:/vcpkg/installed/x64-windows/lib/opencv_core4.lib",
            "C:/vcpkg/installed/x64-windows/lib/opencv_imgproc4.lib",
            "C:/vcpkg/installed/x64-windows/lib/opencv_imgcodecs4.lib",
            "C:/vcpkg/installed/x64-windows/lib/opencv_highgui4.lib",
            "C:/vcpkg/installed/x64-windows/lib/opencv_videoio4.lib",
            "C:/vcpkg/installed/x64-windows/lib/opencv_calib3d4.lib",
            "C:/vcpkg/installed/x64-windows/lib/opencv_objdetect4.lib",
            "C:/vcpkg/installed/x64-windows/lib/opencv_features2d4.lib",
            "C:/vcpkg/installed/x64-windows/lib/opencv_aruco4.lib"
          ],
          "msvs_settings": {
            "VCCLCompilerTool": {
              "ExceptionHandling": 1
            },
            "globals": {
              "WindowsTargetPlatformVersion": "10.0.22621.0"
            }
          }
        }],
        ["OS!='win'", {
          "cflags": [
            "<!@(pkg-config --cflags opencv4)"
          ],
          "xcode_settings": {
            "GCC_ENABLE_CPP_EXCEPTIONS": "YES",
            "GCC_ENABLE_CPP_RTTI": "YES",
            "CLANG_CXX_LIBRARY": "libc++",
            "MACOSX_DEPLOYMENT_TARGET": "10.7",
            "OTHER_CFLAGS": [
              "<!@(pkg-config --cflags opencv4)"
            ],
            "OTHER_CPLUSPLUSFLAGS": [
              "<!@(pkg-config --cflags opencv4)"
            ]
          },
          "libraries": [
            "<!@(pkg-config --libs opencv4)"
          ]
        }]
      ]
    }
  ]
} 