package cxxi.hub;

import android.content.Context;
import android.content.SharedPreferences;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.security.KeyStore;

import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

/**
 * The secrets this device keeps for the app (platform.getDeviceSecret): the account's data key.
 * Each is encrypted (AES-GCM) by a key of the Android Keystore that never leaves it, and stored in
 * the app's private preferences.
 */
@CapacitorPlugin(name = "DeviceSecrets")
public class DeviceSecretsPlugin extends Plugin {

    private static final String ALIAS = "hub_device_secrets";
    private static final String PREFS = "device_secrets";

    @PluginMethod
    public void get(PluginCall call) {
        String name = call.getString("name");
        if (name == null) { call.reject("name required"); return; }
        String stored = prefs().getString(name, null);
        JSObject result = new JSObject();
        if (stored == null) {
            result.put("value", null);
            call.resolve(result);
            return;
        }
        try {
            ByteBuffer data = ByteBuffer.wrap(Base64.decode(stored, Base64.NO_WRAP));
            byte[] iv = new byte[12];
            data.get(iv);
            byte[] sealed = new byte[data.remaining()];
            data.get(sealed);
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.DECRYPT_MODE, key(), new GCMParameterSpec(128, iv));
            result.put("value", new String(cipher.doFinal(sealed), StandardCharsets.UTF_8));
            call.resolve(result);
        }
        catch (Exception e) {
            call.reject("cannot decrypt the secret", e);
        }
    }

    @PluginMethod
    public void set(PluginCall call) {
        String name = call.getString("name");
        if (name == null) { call.reject("name required"); return; }
        String value = call.getString("value");
        if (value == null) {
            prefs().edit().remove(name).commit();
            call.resolve();
            return;
        }
        try {
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.ENCRYPT_MODE, key());
            byte[] iv = cipher.getIV();
            byte[] sealed = cipher.doFinal(value.getBytes(StandardCharsets.UTF_8));
            byte[] out = ByteBuffer.allocate(iv.length + sealed.length).put(iv).put(sealed).array();
            prefs().edit().putString(name, Base64.encodeToString(out, Base64.NO_WRAP)).commit();
            call.resolve();
        }
        catch (Exception e) {
            call.reject("cannot encrypt the secret", e);
        }
    }

    private SharedPreferences prefs() {
        return getContext().getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    private static SecretKey key() throws Exception {
        KeyStore store = KeyStore.getInstance("AndroidKeyStore");
        store.load(null);
        if (store.containsAlias(ALIAS)) {
            return ((KeyStore.SecretKeyEntry) store.getEntry(ALIAS, null)).getSecretKey();
        }
        KeyGenerator generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
        generator.init(new KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
            .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
            .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
            .setKeySize(256)
            .build());
        return generator.generateKey();
    }
}
