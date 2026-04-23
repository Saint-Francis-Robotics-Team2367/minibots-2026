cmake_minimum_required(VERSION 3.16)
include($ENV{IDF_PATH}/tools/cmake/project.cmake)
project(minicore_dongle)

# `idf.py build` then from build dir: cmake --build . --target deploy
# (or: firmware/esp32s3-dongle/scripts/deploy.sh)
add_custom_target(
  deploy
  COMMAND "${CMAKE_SOURCE_DIR}/scripts/deploy.sh"
  USES_TERMINAL
  VERBATIM
  WORKING_DIRECTORY ${CMAKE_SOURCE_DIR}
)
