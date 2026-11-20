# The local AI engine for Android (platforms/ai-engine/README.md, client docs/plan-ia-android.md): a
# server of the desktop's engine built as a library the app loads (Android runs no executable from
# the app's files). Here ENGINE=text: llama.cpp's llama-server. The voice (qwentts.cpp's tts-server)
# builds as its own top-level project, voice.cmake injected (build.sh): it can't be a subproject.
# One library per engine (each brings its own ggml), self-contained (libc++ static, every symbol but
# the JNI entry point hidden), run in the app's AI process (cxxi.hub.AiService).
cmake_minimum_required(VERSION 3.22)
project(hubbyware-ai-android C CXX)

set(ENGINE "" CACHE STRING "text | voice")
set(UPSTREAM "" CACHE PATH "the upstream sources (llama.cpp for text, qwentts.cpp for voice)")

set(BUILD_SHARED_LIBS OFF CACHE BOOL "" FORCE)
set(CMAKE_POSITION_INDEPENDENT_CODE ON)
set(GGML_NATIVE OFF CACHE BOOL "" FORCE)
set(GGML_OPENMP OFF CACHE BOOL "" FORCE)
set(GGML_BACKEND_DL OFF CACHE BOOL "" FORCE)

if(ENGINE STREQUAL "text")
    set(LLAMA_CURL OFF CACHE BOOL "" FORCE)
    set(LLAMA_OPENSSL OFF CACHE BOOL "" FORCE)
    set(LLAMA_BUILD_TESTS OFF CACHE BOOL "" FORCE)
    set(LLAMA_BUILD_EXAMPLES OFF CACHE BOOL "" FORCE)
    set(LLAMA_BUILD_COMMON ON CACHE BOOL "" FORCE)
    set(LLAMA_BUILD_TOOLS ON CACHE BOOL "" FORCE)
    set(LLAMA_BUILD_SERVER ON CACHE BOOL "" FORCE)
    set(LLAMA_BUILD_APP OFF CACHE BOOL "" FORCE)
    set(LLAMA_BUILD_UI OFF CACHE BOOL "" FORCE)
    set(LLAMA_USE_PREBUILT_UI OFF CACHE BOOL "" FORCE)
    set(LLAMA_CONNECT OFF CACHE BOOL "" FORCE)
    add_subdirectory(${UPSTREAM} upstream EXCLUDE_FROM_ALL)
    add_library(hubai-text SHARED engine_jni.cpp)
    target_compile_definitions(hubai-text PRIVATE HUB_ENGINE_TEXT)
    target_link_libraries(hubai-text PRIVATE llama-server-impl log)
    set(LIB hubai-text)
else()
    message(FATAL_ERROR "ENGINE: text (the voice: voice.cmake)")
endif()

set_target_properties(${LIB} PROPERTIES CXX_VISIBILITY_PRESET hidden)
target_compile_features(${LIB} PRIVATE cxx_std_17)
# the static libraries' symbols (ggml's, libc++'s) stay inside: two engines never clash
target_link_options(${LIB} PRIVATE "-Wl,--exclude-libs,ALL" "-Wl,--gc-sections" "-s")
