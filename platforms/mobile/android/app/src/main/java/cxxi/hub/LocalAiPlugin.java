package cxxi.hub;

import android.util.Base64;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.Arrays;

/**
 * The local AI engine from the web side (client docs/plan-ia-android.md). Phase 1: the engines'
 * self-test only — a model in the app's external files (`Android/data/cxxi.hub/files/ai-test/`,
 * pushed by adb), one answer or one line of speech — to check the downloaded engines run here.
 * `ai.chat` / `ai.speech` come in phase 2.
 */
@CapacitorPlugin(name = "LocalAi")
public class LocalAiPlugin extends Plugin {

    private File testFile(String name) throws IOException {
        if (name == null || !name.matches("[A-Za-z0-9._-]+")) throw new IOException("a file name in ai-test/");
        File dir = getContext().getExternalFilesDir("ai-test");
        File f = new File(dir, name);
        if (!f.isFile()) throw new IOException(f.getAbsolutePath() + " not found");
        return f;
    }

    /** selfTest({ engine: 'text', model, prompt }) | selfTest({ engine: 'voice', talker, codec, sample, transcript, text }) */
    @PluginMethod
    public void selfTest(PluginCall call) {
        new Thread(() -> {
            try {
                String engine = call.getString("engine", "text");
                long started = System.currentTimeMillis();
                JSObject ret = new JSObject();
                if ("voice".equals(engine)) {
                    File talker = testFile(call.getString("talker"));
                    File codec = testFile(call.getString("codec"));
                    AiEngine.get().use(getContext(), new AiEngine.Spec("voice", Arrays.asList("--model", talker.getAbsolutePath(), "--codec", codec.getAbsolutePath())));
                    long ready = System.currentTimeMillis();
                    JSONObject voice = new JSONObject()
                        .put("name", "selftest")
                        .put("ref_text", call.getString("transcript", ""))
                        .put("wav_b64", Base64.encodeToString(read(testFile(call.getString("sample"))), Base64.NO_WRAP));
                    AiEngine.get().request("/v1/audio/voices", voice.toString());
                    JSONObject speech = new JSONObject().put("input", call.getString("text", "Bonjour.")).put("voice", "selftest").put("response_format", "wav").put("language", "French");
                    byte[] wav = AiEngine.get().request("/v1/audio/speech", speech.toString());
                    File out = new File(getContext().getExternalFilesDir("ai-test"), "selftest.wav");
                    try (FileOutputStream o = new FileOutputStream(out)) { o.write(wav); }
                    ret.put("startMs", ready - started);
                    ret.put("speechMs", System.currentTimeMillis() - ready);
                    ret.put("bytes", wav.length);
                    ret.put("file", out.getAbsolutePath());
                } else {
                    File model = testFile(call.getString("model"));
                    AiEngine.get().use(getContext(), new AiEngine.Spec("text", Arrays.asList("-m", model.getAbsolutePath(), "-c", "4096", "--jinja")));
                    long ready = System.currentTimeMillis();
                    JSONObject body = new JSONObject()
                        .put("messages", new JSONArray().put(new JSONObject().put("role", "user").put("content", call.getString("prompt", "Dis bonjour en une phrase."))))
                        .put("max_tokens", 120);
                    JSONObject res = new JSONObject(new String(AiEngine.get().request("/v1/chat/completions", body.toString()), StandardCharsets.UTF_8));
                    ret.put("startMs", ready - started);
                    ret.put("answerMs", System.currentTimeMillis() - ready);
                    ret.put("text", res.getJSONArray("choices").getJSONObject(0).getJSONObject("message").optString("content"));
                    ret.put("timings", res.optJSONObject("timings") != null ? res.optJSONObject("timings").toString() : null);
                }
                call.resolve(ret);
            } catch (Exception e) {
                call.reject(e.getMessage() != null ? e.getMessage() : e.toString());
            }
        }, "ai-selftest").start();
    }

    /** The running engine stopped (its process and its model's memory go). */
    @PluginMethod
    public void stop(PluginCall call) {
        AiEngine.get().stop(getContext());
        call.resolve();
    }

    private static byte[] read(File f) throws IOException {
        try (InputStream in = new FileInputStream(f)) {
            byte[] b = new byte[(int) f.length()];
            int at = 0, n;
            while (at < b.length && (n = in.read(b, at, b.length - at)) > 0) at += n;
            return b;
        }
    }
}
