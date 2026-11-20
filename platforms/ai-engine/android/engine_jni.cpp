// The JNI entry point of an engine library (CMakeLists.txt): runs the server's main with the given
// arguments on the calling thread until it returns; its stdout and stderr go to logcat.
#include <jni.h>
#include <android/log.h>
#include <pthread.h>
#include <unistd.h>
#include <cstdio>
#include <string>
#include <vector>

#if defined(HUB_ENGINE_TEXT)
int llama_server(int argc, char ** argv);
static int run_server(int argc, char ** argv) { return llama_server(argc, argv); }
#define HUB_TAG "AiEngine/text"
#define HUB_JNI(name) Java_cxxi_hub_AiService_runText
#elif defined(HUB_ENGINE_VOICE)
int tts_server_main(int argc, char ** argv);
static int run_server(int argc, char ** argv) { return tts_server_main(argc, argv); }
#define HUB_TAG "AiEngine/voice"
#define HUB_JNI(name) Java_cxxi_hub_AiService_runVoice
#endif

static void * pump(void * arg) {
    int fd = static_cast<int>(reinterpret_cast<intptr_t>(arg));
    FILE * in = fdopen(fd, "r");
    char line[2048];
    while (in && fgets(line, sizeof line, in)) __android_log_write(ANDROID_LOG_INFO, HUB_TAG, line);
    return nullptr;
}

// the process's stdout and stderr into logcat (this process runs nothing else)
static void to_logcat() {
    int fds[2];
    if (pipe(fds) != 0) return;
    setvbuf(stdout, nullptr, _IOLBF, 0);
    setvbuf(stderr, nullptr, _IONBF, 0);
    dup2(fds[1], STDOUT_FILENO);
    dup2(fds[1], STDERR_FILENO);
    pthread_t thread;
    if (pthread_create(&thread, nullptr, pump, reinterpret_cast<void *>(static_cast<intptr_t>(fds[0]))) == 0) pthread_detach(thread);
}

extern "C" JNIEXPORT jint JNICALL HUB_JNI(run)(JNIEnv * env, jclass, jobjectArray args) {
    to_logcat();
    std::vector<std::string> owned;
    owned.emplace_back(HUB_TAG);
    for (jsize i = 0, n = env->GetArrayLength(args); i < n; i++) {
        auto s = static_cast<jstring>(env->GetObjectArrayElement(args, i));
        const char * c = env->GetStringUTFChars(s, nullptr);
        owned.emplace_back(c);
        env->ReleaseStringUTFChars(s, c);
        env->DeleteLocalRef(s);
    }
    std::vector<char *> argv;
    for (auto & s : owned) argv.push_back(s.data());
    argv.push_back(nullptr);
    return run_server(static_cast<int>(owned.size()), argv.data());
}

// A plain C entry point too, for a test launcher (adb shell, no JVM)
extern "C" __attribute__((visibility("default"))) int hub_engine_main(int argc, char ** argv) { return run_server(argc, argv); }
