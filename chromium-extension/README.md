# PassFF for Chromium (self-hosted)

A small, self-contained Chromium/Chrome extension that talks to the PassFF
native messaging host (this repo) to read your [zx2c4 `pass`](https://www.passwordstore.org/)
store. No third-party code, no Web Store — you load it yourself and it works on
any machine where the host is installed.

It can:

- list and search your password entries,
- copy the password / login to the clipboard,
- fill the login form of the current page.

## Stable extension id

The extension pins its identity with a `key` in `manifest.json`, so it always
gets the **same id on every device**:

```
kmnojihalnnnimckkdclnfmjpbndnljk
```

The native messaging host's manifest authorises exactly this id
(`allowed_origins`), which is why it works as soon as the host is installed —
nothing per-machine to reconfigure.

`signing-key.pem` (git-ignored) is the private key behind that id. You only need
it if you later want to pack a `.crx`; loading unpacked does not require it.

## Install

1. **Install the native messaging host** for your browser (from the repo root):

   ```bash
   # Snap Chromium (Ubuntu):
   make install BROWSER=chromium-snap
   # or a regular Chromium / Chrome:
   ./src/install_host_app.sh --local chromium      # or: chrome
   ```

   This installs the host and a manifest that allows this extension's id. For
   Snap Chromium it also sets up the socket bridge daemon
   (`passff-host-chromium.service`); see the main README.

2. **Load the extension** in Chromium:
   - open `chrome://extensions`,
   - enable **Developer mode** (top right),
   - click **Load unpacked** and select this `chromium-extension/` directory.

   Confirm the id shown matches the one above.

3. Click the PassFF toolbar icon. The popup lists your store; click an entry to
   copy or fill its credentials.

## Using a different extension id

If you change the manifest `key` (or remove it and let Chrome assign a random
id), reinstall the host with your id:

```bash
CHROME_EXTENSION_ID=<your-32-char-id> ./src/install_host_app.sh --local chromium-snap
```
