# Layout Android release configuration

- Permanent application ID: `com.buildr.layout`
- App link scheme: `buildr-layout://`
- Web fallback host: `https://layout-buildr.vercel.app`
- Initial version: version code `1`, version name `1.0.0`
- Android range: minimum SDK 24, compile/target SDK 36
- Permissions: internet and network state only. Camera, location, and background location are not requested.
- Chromebook: the touchscreen is optional hardware and the main activity is resizable.

## Signing

The keystore and passwords must never be committed. The release workflow expects these GitHub Actions secrets:

- `ANDROID_KEYSTORE_BASE64`
- `ANDROID_KEYSTORE_PASSWORD`
- `ANDROID_KEY_ALIAS`
- `ANDROID_KEY_PASSWORD`

The same Layout upload key must be retained for all future Layout updates. The Gradle release task intentionally fails when signing credentials are absent.

Before enabling verified HTTPS app links, publish `/.well-known/assetlinks.json` on the fallback host with the Play signing certificate fingerprint. Custom-scheme links continue to work without that file, and web URLs remain the safe not-installed fallback.
