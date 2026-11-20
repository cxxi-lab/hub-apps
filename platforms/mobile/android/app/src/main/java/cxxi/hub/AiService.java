package cxxi.hub;

import android.app.Service;
import android.content.Intent;
import android.os.Binder;
import android.os.IBinder;
import android.os.Process;
import android.util.Log;

/**
 * The AI process (android:process=":ai", client docs/plan-ia-android.md): runs one engine server
 * ({@link AiEngineComponent}'s library, its main on a thread) listening on 127.0.0.1, for as long as
 * the app stays bound ({@link AiEngine}). Its own process: the memory a model takes goes with it,
 * Android kills it rather than the app when memory runs short, and unbinding ends it — the next
 * model starts in a fresh one.
 */
public class AiService extends Service {
    private static final String TAG = "AiService";
    static final String EXTRA_ENGINE = "engine";
    static final String EXTRA_LIBRARY = "library";
    static final String EXTRA_ARGS = "args";

    private static native int runText(String[] args);
    private static native int runVoice(String[] args);

    private boolean started;

    @Override
    public IBinder onBind(Intent intent) {
        start(intent);
        return new Binder();
    }

    private synchronized void start(Intent intent) {
        if (started) return;
        started = true;
        String engine = intent.getStringExtra(EXTRA_ENGINE);
        String library = intent.getStringExtra(EXTRA_LIBRARY);
        String[] args = intent.getStringArrayExtra(EXTRA_ARGS);
        Thread thread = new Thread(() -> {
            int code = -1;
            try {
                System.load(library);
                code = "voice".equals(engine) ? runVoice(args) : runText(args);
            } catch (Throwable e) {
                Log.e(TAG, "the " + engine + " engine failed", e);
            }
            // the server returned (it failed to start, or stopped): this process has no other use
            Log.i(TAG, "the " + engine + " engine ended (" + code + ")");
            Process.killProcess(Process.myPid());
        }, "ai-" + engine);
        thread.start();
    }

    @Override
    public boolean onUnbind(Intent intent) {
        // the app let go: the model's memory goes with the process
        Process.killProcess(Process.myPid());
        return false;
    }
}
