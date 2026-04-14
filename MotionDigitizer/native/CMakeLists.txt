cmake_minimum_required(VERSION 3.16)
project(opencv_module)

# Node.jsのパスを設定（環境に応じて変更）
set(NODE_ROOT_DIR "C:/Program Files/nodejs")
set(NODE_INCLUDE_DIR "${NODE_ROOT_DIR}/include/node")

# node-addon-apiのパスを設定
set(NODE_ADDON_API_DIR "${CMAKE_CURRENT_SOURCE_DIR}/../node_modules/node-addon-api")

# OpenCVのパスをvcpkgに変更
set(OpenCV_DIR "C:/vcpkg/installed/x64-windows/share/opencv4")
set(OpenCV_INCLUDE_DIRS "C:/vcpkg/installed/x64-windows/include/opencv4")
# 必要なライブラリを追加
set(OpenCV_LIBRARIES 
    "C:/vcpkg/installed/x64-windows/lib/opencv_core4.lib"
    "C:/vcpkg/installed/x64-windows/lib/opencv_imgproc4.lib"
    "C:/vcpkg/installed/x64-windows/lib/opencv_highgui4.lib"
    "C:/vcpkg/installed/x64-windows/lib/opencv_videoio4.lib"
    "C:/vcpkg/installed/x64-windows/lib/opencv_calib3d4.lib"
    "C:/vcpkg/installed/x64-windows/lib/opencv_aruco4.lib"
    "C:/vcpkg/installed/x64-windows/lib/opencv_features2d4.lib"
)

# コンパイラ設定
set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

# インクルードディレクトリ
include_directories(${NODE_INCLUDE_DIR} ${NODE_ADDON_API_DIR} ${OpenCV_INCLUDE_DIRS})

# ソースファイル
set(SOURCES opencv_module.cpp)

# ライブラリ作成
add_library(opencv_module SHARED ${SOURCES})

# リンク設定
target_link_libraries(opencv_module ${OpenCV_LIBRARIES})

# 出力設定
set_target_properties(opencv_module PROPERTIES
    PREFIX ""
    SUFFIX ".node"
    OUTPUT_NAME "opencv_module"
)

# デバッグ情報
if(CMAKE_BUILD_TYPE STREQUAL "Debug")
    target_compile_definitions(opencv_module PRIVATE DEBUG)
endif() 