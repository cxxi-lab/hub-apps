package cxxi.hub;

import android.content.Context;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Log;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import java.util.List;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

/**
 * The user's VPN configs (server docs/plan-reseau-vpn.md, phase 3): a WireGuard config per hubby
 * going out through the VPN, the user's own. Kept by the app, encrypted with a key of the Android
 * Keystore (AES-GCM, never leaves the device), in filesDir/vpn/<hubby>.conf.sealed; only the tunnel
 * reads it: the web side gets back whether there is one and its endpoint, never the config.
 */
final class VpnConfigs {
    private static final String TAG = "VpnConfigs";
    private static final String KEY = "vpn-configs";
    private static final Pattern HUBBY = Pattern.compile("^[a-z0-9-]{1,80}$");
    private static final Pattern ENDPOINT = Pattern.compile("(?im)^\\s*Endpoint\\s*=\\s*(.+)$");

    private VpnConfigs() {}

    static boolean validHubby(String hubby) {
        return hubby != null && HUBBY.matcher(hubby).matches();
    }

    /** The hubby meant when none is named (an older hubby bundle): the first going out through the VPN. */
    static String defaultHubby() {
        List<String> hubbies = HubbyStore.get().vpnHubbies();
        return hubbies.isEmpty() ? null : hubbies.get(0);
    }

    private static File sealed(Context context, String hubby) {
        return new File(new File(context.getFilesDir(), "vpn"), hubby + ".conf.sealed");
    }

    /** Before configs were per hubby: one config for the device, in clear. */
    private static File legacy(Context context) {
        return new File(context.getFilesDir(), "vpn.conf");
    }

    /** Why a text isn't a usable WireGuard config (null: it is). */
    static String invalid(String text) {
        int interfaces = count(text, "(?im)^\\s*\\[Interface\\]\\s*$");
        int peers = count(text, "(?im)^\\s*\\[Peer\\]\\s*$");
        if (interfaces != 1) return "not a WireGuard config: it needs one [Interface]";
        if (peers != 1) return "the tunnel takes a config with exactly one [Peer]";
        if (!Pattern.compile("(?im)^\\s*PrivateKey\\s*=\\s*\\S+").matcher(text).find()) return "the [Interface] has no PrivateKey";
        if (!Pattern.compile("(?im)^\\s*Address\\s*=\\s*\\S+").matcher(text).find()) return "the [Interface] has no Address";
        if (!Pattern.compile("(?im)^\\s*PublicKey\\s*=\\s*\\S+").matcher(text).find()) return "the [Peer] has no PublicKey";
        if (!ENDPOINT.matcher(text).find()) return "the [Peer] has no Endpoint";
        return null;
    }

    static String endpointOf(String text) {
        Matcher m = ENDPOINT.matcher(text);
        return m.find() ? m.group(1).trim() : null;
    }

    private static int count(String text, String regex) {
        Matcher m = Pattern.compile(regex).matcher(text);
        int n = 0;
        while (m.find()) n++;
        return n;
    }

    /** Saves a hubby's config (encrypted). Throws when the text isn't a config. */
    static synchronized void write(Context context, String hubby, String text) throws Exception {
        String why = invalid(text);
        if (why != null) throw new Exception(why);
        File file = sealed(context, hubby);
        File dir = file.getParentFile();
        if (dir == null || (!dir.isDirectory() && !dir.mkdirs())) throw new IOException("no folder for the VPN configs");
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.ENCRYPT_MODE, key());
        byte[] iv = cipher.getIV();
        byte[] body = cipher.doFinal(text.getBytes(StandardCharsets.UTF_8));
        File part = new File(dir, file.getName() + ".part");
        try (FileOutputStream out = new FileOutputStream(part)) {
            out.write(ByteBuffer.allocate(4).putInt(iv.length).array());
            out.write(iv);
            out.write(body);
        }
        if (!part.renameTo(file)) throw new IOException("couldn't save the VPN config");
    }

    static synchronized void remove(Context context, String hubby) {
        //noinspection ResultOfMethodCallIgnored
        sealed(context, hubby).delete();
    }

    /**
     * A hubby's config, in clear (for the tunnel only). The device's former single config is taken
     * over by the first hubby asking (encrypted, then the clear file removed).
     */
    static synchronized String read(Context context, String hubby) {
        File file = sealed(context, hubby);
        try {
            if (file.isFile()) {
                byte[] all;
                try (InputStream in = new FileInputStream(file)) {
                    all = readBytes(in);
                }
                ByteBuffer buffer = ByteBuffer.wrap(all);
                byte[] iv = new byte[buffer.getInt()];
                buffer.get(iv);
                byte[] body = new byte[buffer.remaining()];
                buffer.get(body);
                Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
                cipher.init(Cipher.DECRYPT_MODE, key(), new GCMParameterSpec(128, iv));
                return new String(cipher.doFinal(body), StandardCharsets.UTF_8);
            }
            File old = legacy(context);
            if (old.isFile()) {
                String text = TunnelManager.readFile(old);
                try {
                    write(context, hubby, text);
                    //noinspection ResultOfMethodCallIgnored
                    old.delete();
                    Log.i(TAG, "the device's config is now " + hubby + "'s (encrypted)");
                } catch (Exception e) {
                    Log.w(TAG, "the former config stays as it is", e);
                }
                return text;
            }
        } catch (Exception e) {
            Log.e(TAG, "cannot read the VPN config of " + hubby, e);
        }
        return null;
    }

    private static SecretKey key() throws Exception {
        KeyStore store = KeyStore.getInstance("AndroidKeyStore");
        store.load(null);
        if (store.containsAlias(KEY)) return ((KeyStore.SecretKeyEntry) store.getEntry(KEY, null)).getSecretKey();
        KeyGenerator generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
        generator.init(new KeyGenParameterSpec.Builder(KEY, KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .build());
        return generator.generateKey();
    }

    private static byte[] readBytes(InputStream in) throws IOException {
        java.io.ByteArrayOutputStream out = new java.io.ByteArrayOutputStream();
        byte[] buffer = new byte[8192];
        int n;
        while ((n = in.read(buffer)) > 0) out.write(buffer, 0, n);
        return out.toByteArray();
    }
}
