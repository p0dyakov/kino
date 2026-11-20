cmake_minimum_required(VERSION 3.24)
project(ksengine CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

find_package(PkgConfig REQUIRED)
pkg_check_modules(LIBTORRENT REQUIRED IMPORTED_TARGET libtorrent-rasterbar)
pkg_check_modules(FFMPEG REQUIRED IMPORTED_TARGET libavformat libavcodec libavutil libswresample)

add_executable(ksengine
    src/main.cpp
    src/engine.cpp
    src/peerrelay.cpp
    src/transmux.cpp
    src/webview.mm
)

target_compile_options(ksengine PRIVATE -O2 -Wall)
target_compile_definitions(ksengine PRIVATE CPPHTTPLIB_OPENSSL_SUPPORT)
target_include_directories(ksengine PRIVATE
    ${CMAKE_CURRENT_SOURCE_DIR}/vendor
    /opt/homebrew/include
)
target_link_directories(ksengine PRIVATE /opt/homebrew/lib)

target_link_libraries(ksengine PRIVATE
    PkgConfig::LIBTORRENT
    PkgConfig::FFMPEG
    "-framework Cocoa"
    "-framework WebKit"
    ssl
    crypto
)

set_target_properties(ksengine PROPERTIES
    MACOSX_RPATH ON
    BUILD_RPATH "/opt/homebrew/lib;/opt/homebrew/Cellar/libtorrent-rasterbar/2.1.2_2/lib"
    INSTALL_RPATH "/opt/homebrew/lib"
)
