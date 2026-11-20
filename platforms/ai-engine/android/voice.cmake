# The voice engine library (CMakeLists.txt), injected into qwentts.cpp's own project by build.sh
# (CMAKE_PROJECT_qwentts-ggml_INCLUDE): qwentts.cpp builds only as a top-level project. Its targets
# (qwen-core, httplib, yyjson) are defined after this file runs: linking them by name is fine.
set(BUILD_SHARED_LIBS OFF CACHE BOOL "" FORCE)
set(CMAKE_POSITION_INDEPENDENT_CODE ON)
set(GGML_NATIVE OFF CACHE BOOL "" FORCE)
set(GGML_OPENMP OFF CACHE BOOL "" FORCE)
set(GGML_BACKEND_DL OFF CACHE BOOL "" FORCE)

# tts-server's main, renamed: called by the JNI entry point
add_library(tts-server-impl STATIC EXCLUDE_FROM_ALL ${CMAKE_SOURCE_DIR}/tools/tts-server.cpp)
target_compile_definitions(tts-server-impl PRIVATE main=tts_server_main)
target_include_directories(tts-server-impl PRIVATE ${CMAKE_SOURCE_DIR}/src ${CMAKE_SOURCE_DIR} ${CMAKE_BINARY_DIR})
target_link_libraries(tts-server-impl PUBLIC qwen-core httplib yyjson)
target_compile_features(tts-server-impl PRIVATE cxx_std_17)

add_library(hubai-voice SHARED EXCLUDE_FROM_ALL ${CMAKE_CURRENT_LIST_DIR}/engine_jni.cpp)
target_compile_definitions(hubai-voice PRIVATE HUB_ENGINE_VOICE)
target_link_libraries(hubai-voice PRIVATE tts-server-impl log)
set_target_properties(hubai-voice PROPERTIES CXX_VISIBILITY_PRESET hidden)
target_compile_features(hubai-voice PRIVATE cxx_std_17)
target_link_options(hubai-voice PRIVATE "-Wl,--exclude-libs,ALL" "-Wl,--gc-sections" "-s")
