package cxxi.hub;

import android.animation.Animator;
import android.animation.AnimatorListenerAdapter;
import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.Context;
import android.content.Intent;
import android.graphics.Bitmap;
import android.graphics.Color;
import android.graphics.Rect;
import android.graphics.drawable.GradientDrawable;
import android.os.Build;
import android.os.Bundle;
import android.util.Log;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.MotionEvent;
import android.view.View;
import android.view.ViewConfiguration;
import android.view.ViewGroup;
import android.view.WindowInsets;
import android.view.WindowInsetsController;
import android.view.animation.DecelerateInterpolator;
import android.webkit.ConsoleMessage;
import android.webkit.HttpAuthHandler;
import android.webkit.JavascriptInterface;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.ProgressBar;
import android.widget.ScrollView;
import android.widget.TextView;

import androidx.webkit.ScriptHandler;
import androidx.webkit.WebViewCompat;
import androidx.webkit.WebViewFeature;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayInputStream;
import java.util.Collections;
import java.util.HashMap;
import java.util.HashSet;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

import static android.view.ViewGroup.LayoutParams.MATCH_PARENT;
import static android.view.ViewGroup.LayoutParams.WRAP_CONTENT;

/**
 * Native counterpart of the web VideoPlayerModal on phones: the page plays in a
 * 16:9 frame as large as the screen allows, on black. Swiping on the black
 * around it slides the frame away and the neighbour's poster in (the web side
 * then opens that video), the cross in the top-left corner closes the player
 * (not a tap beside the video: too easy to hit by accident), and the gear in
 * the top-right corner unfolds the actions the web side handed over (their
 * taps go back to it). The frame stays covered by the poster until the bootstrap script
 * answers, like the web's playerReady. The WebView rides the tunnel's proxy
 * override (process-wide) and answers its 407 through {@link TunnelManager}.
 *
 * Only one player at a time; {@link PlayerPlugin} drives it through the
 * static {@link #current} handle and hears back through {@link #listener}.
 */
public class PlayerActivity extends Activity {

    interface Listener {
        void onReady(String result);

        void onClosed();

        void onAction(String id);

        void onNavigate(String direction);
    }

    private static final String TAG = "hub-player";
    // Intent extras: the web side's NativePlayerOptions (filled by PlayerPlugin.open).
    static final String EXTRA_URL = "url";
    static final String EXTRA_REFERRER = "referrer";
    static final String EXTRA_BOOTSTRAP = "bootstrap";
    static final String EXTRA_POSTER = "poster";
    static final String EXTRA_HAS_PREV = "hasPrev";
    static final String EXTRA_HAS_NEXT = "hasNext";
    static final String EXTRA_PREV_POSTER = "prevPoster";
    static final String EXTRA_NEXT_POSTER = "nextPoster";
    static final String EXTRA_PRELOAD = "preloadPosters";

    // The web theme's colours (app/src/styles/index.css).
    private static final int STEEL_100 = 0xFF8C9BAB;
    private static final int STEEL_300 = 0xFF738496;
    private static final int STEEL_700 = 0xFF303B4C;
    private static final int STEEL_800 = 0xFF24282F;
    private static final int STEEL_900 = 0xFF1D2025;
    private static final int STEEL_950 = 0xFF1E2025;
    private static final int RED_500 = 0xFFE2483D;
    private static final int PRIMARY_300 = 0xFF85B8FF;

    /**
     * Desktop pages are taller than the frame, so a finger dragging a player's
     * timeline pans the page instead: the browser takes the gesture and the
     * player's own touch handlers only get uncancellable events, then a cancel.
     * No touch panning in any frame (the video already fills the frame) leaves
     * those gestures to the page.
     */
    private static final String NO_TOUCH_PANNING =
        "document.documentElement.style.setProperty('touch-action', 'none', 'important')";

    /** Share of the frame width past which a released swipe changes the video. */
    private static final float SWIPE_COMMIT = 0.2f;
    private static final long SLIDE_MS = 220;

    static volatile PlayerActivity current;
    static volatile Listener listener;
    /** Latest actions + gear / close icons from the web side; kept here as they may arrive before the activity exists. */
    static volatile JSONArray actions;
    static volatile JSONObject icons;

    private Stage stage;
    private FrameLayout track;
    private FrameLayout frame;
    private WebView web;
    private ImageView coverPoster;
    private View cover;
    private ImageView prevPoster;
    private ImageView nextPoster;
    private FrameLayout panel;
    private LinearLayout menu;
    private FrameLayout closeSlot;
    private View fullscreenView;
    private ScriptHandler bootstrapHandle;

    private boolean actionsOpen;
    private boolean hasPrev;
    private boolean hasNext;
    private String prevPosterUrl;
    private String nextPosterUrl;
    private boolean sliding;

    static void open(Context context, Bundle options) {
        Intent intent = new Intent(context, PlayerActivity.class).putExtras(options);
        // A second open() replaces the video in the running player.
        intent.addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP);
        if (!(context instanceof Activity)) intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        context.startActivity(intent);
    }

    @SuppressLint({"SetJavaScriptEnabled", "AddJavascriptInterface"})
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        current = this;

        stage = new Stage(this);
        stage.setBackgroundColor(Color.BLACK);

        track = new FrameLayout(this);
        stage.addView(track, new FrameLayout.LayoutParams(MATCH_PARENT, MATCH_PARENT));

        prevPoster = posterView();
        nextPoster = posterView();
        track.addView(prevPoster);
        track.addView(nextPoster);

        frame = new FrameLayout(this);
        frame.setBackgroundColor(Color.BLACK);
        track.addView(frame);

        web = new WebView(this);
        web.getSettings().setJavaScriptEnabled(true);
        web.getSettings().setDomStorageEnabled(true);
        // desktop: webpreferences="autoplayPolicy=user-gesture-required"
        web.getSettings().setMediaPlaybackRequiresUserGesture(true);
        // Same page as desktop's player: with the WebView's mobile UA the site
        // serves its mobile layout, which the player scripts don't target.
        web.getSettings().setUserAgentString(desktopUserAgent(this));
        web.setBackgroundColor(Color.BLACK);
        web.setWebViewClient(new WebViewClient() {
            @Override
            public void onReceivedHttpAuthRequest(WebView view, HttpAuthHandler handler, String host, String realm) {
                TunnelManager.get().handleAuth(handler, host, realm);
            }

            @Override
            public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                // Ads and trackers (the back's blocklist): an empty refusal, as desktop cancels them.
                if (PlayerBlocklist.get(PlayerActivity.this).isBlocked(request.getUrl().getHost())) {
                    return new WebResourceResponse("text/plain", "utf-8", 403, "Blocked",
                        new HashMap<>(), new ByteArrayInputStream(new byte[0]));
                }
                return null;
            }
        });
        web.setWebChromeClient(new Chrome());
        if (WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)) {
            WebViewCompat.addDocumentStartJavaScript(web, NO_TOUCH_PANNING, new HashSet<>(Collections.singletonList("*")));
        }
        web.addJavascriptInterface(new Bridge(), "HubBridge");
        frame.addView(web, new FrameLayout.LayoutParams(MATCH_PARENT, MATCH_PARENT));
        keepTimelineFromBackGesture(web);

        // Cover until the bootstrap answers: the poster (the one a swipe slid in) + a spinner.
        FrameLayout coverLayout = new FrameLayout(this);
        coverLayout.setBackgroundColor(Color.BLACK);
        coverPoster = posterView();
        coverLayout.addView(coverPoster, new FrameLayout.LayoutParams(MATCH_PARENT, MATCH_PARENT));
        coverLayout.addView(new ProgressBar(this), new FrameLayout.LayoutParams(WRAP_CONTENT, WRAP_CONTENT, Gravity.CENTER));
        cover = coverLayout;
        frame.addView(cover, new FrameLayout.LayoutParams(MATCH_PARENT, MATCH_PARENT));

        panel = new FrameLayout(this);
        panel.setBackgroundColor(0xD9000000);
        panel.setVisibility(View.GONE);
        panel.setOnClickListener(v -> hidePanel());
        frame.addView(panel, new FrameLayout.LayoutParams(MATCH_PARENT, MATCH_PARENT));

        menu = new LinearLayout(this);
        menu.setGravity(Gravity.CENTER);
        FrameLayout.LayoutParams menuParams = new FrameLayout.LayoutParams(WRAP_CONTENT, WRAP_CONTENT, Gravity.TOP | Gravity.END);
        menuParams.topMargin = dp(16);
        menuParams.rightMargin = dp(16);
        stage.addView(menu, menuParams);

        closeSlot = new FrameLayout(this);
        FrameLayout.LayoutParams closeParams = new FrameLayout.LayoutParams(WRAP_CONTENT, WRAP_CONTENT, Gravity.TOP | Gravity.START);
        closeParams.topMargin = dp(16);
        closeParams.leftMargin = dp(16);
        stage.addView(closeSlot, closeParams);

        setContentView(stage);
        hideSystemBars();
        renderActions();
        load(getIntent());
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        load(intent);
    }

    private void load(Intent intent) {
        String url = intent.getStringExtra(EXTRA_URL);
        String referrer = intent.getStringExtra(EXTRA_REFERRER);
        String bootstrap = intent.getStringExtra(EXTRA_BOOTSTRAP);
        hasPrev = intent.getBooleanExtra(EXTRA_HAS_PREV, false);
        hasNext = intent.getBooleanExtra(EXTRA_HAS_NEXT, false);
        prevPosterUrl = intent.getStringExtra(EXTRA_PREV_POSTER);
        nextPosterUrl = intent.getStringExtra(EXTRA_NEXT_POSTER);
        showPoster(coverPoster, intent.getStringExtra(EXTRA_POSTER));
        showPoster(prevPoster, prevPosterUrl);
        showPoster(nextPoster, nextPosterUrl);
        String[] preload = intent.getStringArrayExtra(EXTRA_PRELOAD);
        if (preload != null) for (String p : preload) PosterCache.preload(p);

        hidePanel();
        cover.setVisibility(View.VISIBLE);
        // A previous video's bootstrap must not run on this one.
        if (bootstrapHandle != null) bootstrapHandle.remove();
        bootstrapHandle = null;
        if (bootstrap != null && WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)) {
            bootstrapHandle = WebViewCompat.addDocumentStartJavaScript(web, domReady(bootstrap), new HashSet<>(Collections.singletonList("*")));
        } else {
            // No script for this site (or no document-start support): nothing to
            // wait for, the player is ready as is.
            if (bootstrap != null) Log.w(TAG, "DOCUMENT_START_SCRIPT unsupported, bootstrap skipped");
            cover.setVisibility(View.GONE);
            Listener l = listener;
            if (l != null) l.onReady("no bootstrap");
        }
        Log.i(TAG, "load " + url + (referrer != null ? " referer=" + referrer : ""));
        if (referrer != null) {
            web.loadUrl(url, Collections.singletonMap("Referer", referrer));
        } else {
            web.loadUrl(url);
        }
    }

    /**
     * Desktop runs the bootstrap with executeJavaScript on dom-ready and awaits
     * its promise; evaluateJavascript can't await, so the script reports back
     * through the HubBridge interface. Top frame only, like executeJavaScript.
     */
    private static String domReady(String bootstrap) {
        return "(function() {\n"
            + "\tif (window.top !== window) return\n"
            + "\tconst run = () => Promise.resolve(" + bootstrap + ")\n"
            + "\t\t.then(r => HubBridge.bootstrap(String(r)))\n"
            + "\t\t.catch(e => HubBridge.bootstrap('error ' + e))\n"
            + "\tif (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', run, { once: true })\n"
            + "\telse run()\n"
            + "})()\n";
    }

    void reload() {
        runOnUiThread(() -> {
            cover.setVisibility(View.VISIBLE);
            web.reload();
        });
    }

    void exec(String script) {
        runOnUiThread(() -> web.evaluateJavascript(script, null));
    }

    @Override
    protected void onDestroy() {
        if (current == this) current = null;
        web.destroy();
        Listener l = listener;
        if (l != null) l.onClosed();
        super.onDestroy();
    }

    @Override
    @SuppressWarnings("deprecation")
    public void onBackPressed() {
        if (fullscreenView != null) {
            web.getWebChromeClient().onHideCustomView();
        } else if (panel.getVisibility() == View.VISIBLE) {
            hidePanel();
        } else if (actionsOpen) {
            setActionsOpen(false);
        } else {
            super.onBackPressed();
        }
    }

    // --- Layout ---------------------------------------------------------------

    /**
     * Sizes the frame to the largest 16:9 box the screen holds, centred, with
     * the neighbours' posters just past the left and right screen edges, and
     * turns the action list into a row in landscape (a column would run off the
     * bottom). Touches that no child takes (the black around the frame) are
     * swipes or taps.
     */
    private final class Stage extends FrameLayout {

        private final int touchSlop = ViewConfiguration.get(getContext()).getScaledTouchSlop();
        private float downX;
        private float downY;
        private boolean tracking;
        private boolean horizontal;

        Stage(Context context) {
            super(context);
        }

        @Override
        protected void onSizeChanged(int w, int h, int oldw, int oldh) {
            super.onSizeChanged(w, h, oldw, oldh);
            // Called mid-layout: layout changes made here would be dropped, so apply them next frame.
            post(() -> arrange(w, h));
        }

        private void arrange(int w, int h) {
            int fw = Math.min(w, Math.round(h * 16f / 9f));
            int fh = Math.round(fw * 9f / 16f);
            for (View v : new View[]{frame, prevPoster, nextPoster}) {
                v.setLayoutParams(new FrameLayout.LayoutParams(fw, fh));
                v.setY((h - fh) / 2f);
            }
            frame.setX((w - fw) / 2f);
            prevPoster.setX(-fw);
            nextPoster.setX(w);
            boolean landscape = w > h;
            menu.setOrientation(landscape ? LinearLayout.HORIZONTAL : LinearLayout.VERTICAL);
            // Landscape: the gear (first child) stays at the right, the actions unfold to its left.
            menu.setLayoutDirection(landscape ? View.LAYOUT_DIRECTION_RTL : View.LAYOUT_DIRECTION_LTR);
            renderActions();
        }

        @SuppressLint("ClickableViewAccessibility")
        @Override
        public boolean onTouchEvent(MotionEvent e) {
            switch (e.getActionMasked()) {
                case MotionEvent.ACTION_DOWN:
                    if (sliding) return false;
                    downX = e.getX();
                    downY = e.getY();
                    tracking = true;
                    horizontal = false;
                    return true;
                case MotionEvent.ACTION_MOVE: {
                    if (!tracking) return false;
                    float dx = e.getX() - downX;
                    float dy = e.getY() - downY;
                    if (!horizontal) {
                        if (Math.abs(dy) > touchSlop && Math.abs(dy) > Math.abs(dx)) {
                            tracking = false;
                            return false;
                        }
                        if (Math.abs(dx) <= touchSlop) return true;
                        horizontal = true;
                    }
                    // No neighbour on that side: the frame resists instead of following.
                    boolean blocked = dx < 0 ? !hasNext : !hasPrev;
                    track.setTranslationX(blocked ? dx * 0.25f : dx);
                    return true;
                }
                case MotionEvent.ACTION_UP: {
                    if (!tracking) return false;
                    tracking = false;
                    if (horizontal) release(e.getX() - downX);
                    else onBackdropTap();
                    return true;
                }
                case MotionEvent.ACTION_CANCEL:
                    tracking = false;
                    settle(0, null);
                    return true;
                default:
                    return tracking;
            }
        }
    }

    private void release(float dx) {
        boolean next = dx < 0;
        boolean allowed = next ? hasNext : hasPrev;
        if (!allowed || Math.abs(dx) <= frame.getWidth() * SWIPE_COMMIT) {
            settle(0, null);
            return;
        }
        // Slide on until the neighbour's poster sits where the frame is, then
        // show that poster as the cover, snap back and let the web side open it.
        float distance = stage.getWidth() / 2f + frame.getWidth() / 2f;
        ImageView incoming = next ? nextPoster : prevPoster;
        settle(next ? -distance : distance, () -> {
            coverPoster.setImageDrawable(incoming.getDrawable());
            cover.setVisibility(View.VISIBLE);
            hidePanel();
            track.setTranslationX(0);
            Listener l = listener;
            if (l != null) l.onNavigate(next ? "next" : "prev");
        });
    }

    private void settle(float to, Runnable then) {
        sliding = true;
        track.animate()
            .translationX(to)
            .setDuration(SLIDE_MS)
            .setInterpolator(new DecelerateInterpolator())
            .setListener(new AnimatorListenerAdapter() {
                @Override
                public void onAnimationEnd(Animator animation) {
                    track.animate().setListener(null);
                    sliding = false;
                    if (then != null) then.run();
                }
            })
            .start();
    }

    /** A tap beside the video: folds an open panel or menu, never closes (the close button does). */
    private void onBackdropTap() {
        if (panel.getVisibility() == View.VISIBLE) hidePanel();
        else if (actionsOpen) setActionsOpen(false);
    }

    // --- Actions --------------------------------------------------------------

    /** Main thread. Rebuilds the gear + action buttons from {@link #actions}. */
    void renderActions() {
        if (menu == null) return;
        menu.removeAllViews();
        closeSlot.removeAllViews();
        JSONObject set = icons;
        if (set == null) return;
        View close = roundButton(set.optJSONObject("close"), dp(40), dp(18), STEEL_800, STEEL_300);
        close.setContentDescription("Close player");
        close.setOnClickListener(v -> finish());
        closeSlot.addView(close);
        JSONObject gear = set.optJSONObject("menu");
        if (gear == null) return;
        View gearButton = roundButton(gear, dp(40), dp(18), STEEL_800, actionsOpen ? PRIMARY_300 : STEEL_300);
        gearButton.setContentDescription(actionsOpen ? "Hide actions" : "Show actions");
        gearButton.setOnClickListener(v -> setActionsOpen(!actionsOpen));
        menu.addView(gearButton);
        if (!actionsOpen) return;
        JSONArray list = actions;
        if (list == null) return;
        boolean row = menu.getOrientation() == LinearLayout.HORIZONTAL;
        for (int i = 0; i < list.length(); i++) {
            JSONObject a = list.optJSONObject(i);
            if (a == null) continue;
            String id = a.optString("id");
            boolean danger = "danger".equals(a.optString("tone"));
            boolean busy = a.optBoolean("busy");
            View b = roundButton(a.optJSONObject("icon"), dp(36), dp(16), danger ? RED_500 : STEEL_800, danger ? STEEL_950 : STEEL_300);
            b.setContentDescription(a.optString("label"));
            b.setAlpha(busy ? 0.4f : 1f);
            if (!busy) {
                b.setOnClickListener(v -> {
                    Listener l = listener;
                    if (l != null) l.onAction(id);
                });
            }
            LinearLayout.LayoutParams p = new LinearLayout.LayoutParams(dp(36), dp(36));
            if (row) p.setMarginStart(dp(12));
            else p.topMargin = dp(12);
            menu.addView(b, p);
        }
    }

    private void setActionsOpen(boolean open) {
        actionsOpen = open;
        renderActions();
    }

    private View roundButton(JSONObject icon, int size, int iconSize, int background, int iconColor) {
        FrameLayout button = new FrameLayout(this);
        GradientDrawable bg = new GradientDrawable();
        bg.setShape(GradientDrawable.OVAL);
        bg.setColor(background);
        button.setBackground(bg);
        button.setLayoutParams(new LinearLayout.LayoutParams(size, size));
        if (icon != null) {
            ImageView iv = new ImageView(this);
            try {
                iv.setImageDrawable(new PathIconDrawable(
                    (float) icon.getDouble("width"), (float) icon.getDouble("height"), icon.getString("path"), iconColor));
            } catch (Exception e) {
                Log.w(TAG, "bad action icon", e);
            }
            button.addView(iv, new FrameLayout.LayoutParams(iconSize, iconSize, Gravity.CENTER));
        }
        return button;
    }

    // --- Panel (tags, info) ---------------------------------------------------

    /** Main thread. null hides it. */
    void showPanel(JSONObject data) {
        if (data == null) {
            hidePanel();
            return;
        }
        panel.removeAllViews();
        JSONArray chips = data.optJSONArray("chips");
        JSONArray rows = data.optJSONArray("rows");
        if (chips != null) {
            FlowLayout flow = new FlowLayout(this, dp(8));
            flow.setPadding(dp(24), dp(24), dp(24), dp(24));
            for (int i = 0; i < chips.length(); i++) {
                TextView chip = text(chips.optString(i), 14, STEEL_100);
                chip.setPadding(dp(12), dp(6), dp(12), dp(6));
                chip.setBackground(rounded(STEEL_800, 0, dp(6)));
                flow.addView(chip);
            }
            ScrollView scroll = new ScrollView(this);
            scroll.setFillViewport(true);
            FrameLayout centred = new FrameLayout(this);
            centred.addView(flow, new FrameLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT, Gravity.CENTER));
            scroll.addView(centred);
            // Taps between the chips close the panel too.
            centred.setOnClickListener(v -> hidePanel());
            panel.addView(scroll, new FrameLayout.LayoutParams(MATCH_PARENT, MATCH_PARENT));
        } else if (rows != null) {
            LinearLayout card = new LinearLayout(this);
            card.setOrientation(LinearLayout.VERTICAL);
            card.setPadding(dp(20), dp(16), dp(20), dp(16));
            card.setBackground(rounded(STEEL_900, STEEL_700, dp(6)));
            for (int i = 0; i < rows.length(); i++) {
                JSONArray r = rows.optJSONArray(i);
                if (r == null) continue;
                LinearLayout line = new LinearLayout(this);
                TextView label = text(r.optString(0), 12, STEEL_300);
                label.setMinWidth(dp(72));
                line.addView(label);
                line.addView(text(r.optString(1), 12, Color.WHITE));
                LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(WRAP_CONTENT, WRAP_CONTENT);
                if (i > 0) lp.topMargin = dp(8);
                card.addView(line, lp);
            }
            panel.addView(card, new FrameLayout.LayoutParams(WRAP_CONTENT, WRAP_CONTENT, Gravity.CENTER));
        }
        panel.setVisibility(View.VISIBLE);
    }

    private void hidePanel() {
        panel.setVisibility(View.GONE);
        panel.removeAllViews();
    }

    // --- Helpers --------------------------------------------------------------

    private ImageView posterView() {
        ImageView v = new ImageView(this);
        v.setScaleType(ImageView.ScaleType.CENTER_CROP);
        v.setBackgroundColor(Color.BLACK);
        return v;
    }

    /** Shows `url` in `view` (cached: at once); a late answer for an older URL is dropped. */
    private void showPoster(ImageView view, String url) {
        view.setTag(url);
        if (url == null) {
            view.setImageDrawable(null);
            return;
        }
        PosterCache.get(url, (Bitmap bitmap) -> {
            if (url.equals(view.getTag())) view.setImageBitmap(bitmap);
        });
    }

    private TextView text(String s, int sp, int color) {
        TextView t = new TextView(this);
        t.setText(s);
        t.setTextSize(TypedValue.COMPLEX_UNIT_SP, sp);
        t.setTextColor(color);
        return t;
    }

    private static GradientDrawable rounded(int fill, int stroke, int radius) {
        GradientDrawable d = new GradientDrawable();
        d.setColor(fill);
        d.setCornerRadius(radius);
        if (stroke != 0) d.setStroke(1, stroke);
        return d;
    }

    /**
     * The video reaches the screen edges, and with gesture navigation the edges
     * belong to the back gesture: a finger landing on the start (or end) of the
     * timeline swiped back instead of grabbing it. Hands the bottom band of the
     * view, where the player's controls sit, back to the page.
     */
    private void keepTimelineFromBackGesture(View view) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) return;
        view.addOnLayoutChangeListener((v, left, top, right, bottom, oldLeft, oldTop, oldRight, oldBottom) -> {
            int w = right - left;
            int h = bottom - top;
            v.setSystemGestureExclusionRects(Collections.singletonList(new Rect(0, Math.max(0, h - dp(120)), w, h)));
        });
    }

    private int dp(int value) {
        return Math.round(TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, value, getResources().getDisplayMetrics()));
    }

    /**
     * A desktop Chrome UA on the WebView's real Chrome version (desktop's
     * Electron sends one too), so sites serve their desktop layout.
     */
    private static String desktopUserAgent(Context context) {
        Matcher m = Pattern.compile("Chrome/([\\d.]+)").matcher(WebSettings.getDefaultUserAgent(context));
        String chrome = m.find() ? m.group(1) : "140.0.0.0";
        return "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/" + chrome + " Safari/537.36";
    }

    private void hideSystemBars() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R) return; // the Fullscreen theme covers older devices
        WindowInsetsController c = getWindow().getInsetsController();
        if (c == null) return;
        c.hide(WindowInsets.Type.systemBars());
        c.setSystemBarsBehavior(WindowInsetsController.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE);
    }

    private class Bridge {
        @JavascriptInterface
        public void bootstrap(String result) {
            Log.i(TAG, "bootstrap " + result);
            // JavaBridge thread: views are touched on the UI thread.
            runOnUiThread(() -> {
                // desktop sets playerReady on both success and failure
                cover.setVisibility(View.GONE);
                Listener l = listener;
                if (l != null) l.onReady(result);
            });
        }
    }

    private class Chrome extends WebChromeClient {
        @Override
        public boolean onConsoleMessage(ConsoleMessage m) {
            Log.println(m.messageLevel() == ConsoleMessage.MessageLevel.ERROR ? Log.WARN : Log.DEBUG,
                TAG, "console: " + m.message());
            return true;
        }

        @Override
        public void onShowCustomView(View view, CustomViewCallback callback) {
            fullscreenView = view;
            keepTimelineFromBackGesture(view);
            ((ViewGroup) getWindow().getDecorView()).addView(view, new FrameLayout.LayoutParams(MATCH_PARENT, MATCH_PARENT));
        }

        @Override
        public void onHideCustomView() {
            if (fullscreenView != null) ((ViewGroup) getWindow().getDecorView()).removeView(fullscreenView);
            fullscreenView = null;
        }
    }
}
