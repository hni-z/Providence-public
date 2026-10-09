# Providence for Apple Watch

Open `WatchStarter.xcodeproj` in Xcode with watchOS platform support installed. The app uses the local `watch-coordinator-adapter` Swift package. Configure your own bundle identifiers and signing team before installing it.

## Connect the Watch and run

1. **Pair the Watch with an iPhone first.** Turn on Bluetooth and Wi-Fi on the iPhone. Turn on the Watch and hold it nearby. Open the iPhone's **Watch → All Watches → Add Watch → Set Up for Myself** and finish the setup prompts. If this is someone else's already-paired Watch, use their paired iPhone; do not erase it just for this project.
2. **Open `WatchStarter.xcodeproj` on the testing Mac.** If Xcode says watchOS is not installed, install it in **Xcode → Settings → Components**.
3. **Connect the paired iPhone to the Mac with a data-capable USB cable.** Unlock the iPhone and tap **Trust** if asked. Keep the Watch nearby and unlocked, with Wi-Fi and Bluetooth on.
4. **Pair with Xcode.** Open the run-destination menu beside the Run button and choose **Manage Devices**. In newer Xcode this opens Device Hub; older versions use **Window → Devices and Simulators**. Select and pair the iPhone first, then follow the Watch pairing instructions. If necessary use **+ → Pair Nearby Device**. Keep the devices on the same Wi-Fi network as the Mac. Accept Trust prompts on both devices.
5. **Enable Developer Mode on both devices.** On each device, go to **Settings → Privacy & Security → Developer Mode**. Turn it on, restart, and confirm after the restart. If the switch is absent, start pairing in Xcode first, then check again.
6. **Configure signing.** In **Xcode → Settings → Apple Accounts**, sign in with the Apple Account used for development. Click the blue project icon, select the **WatchStarter** target, then **Signing & Capabilities**. Leave **Automatically manage signing** enabled and select your Team. If the bundle ID is unavailable, replace it with a unique identifier such as `com.yourname.yourteam.watchstarter`. The project intentionally has no hardcoded signing team.
7. **Run.** Select the **WatchStarter** scheme and your actual Apple Watch as the destination, then press **⌘R**. Wait for initial device preparation and installation. Keep the Watch unlocked and confirm any on-device prompts.
8. **Configure and test the client.** Follow [Watch routing](docs/WATCH_MAC_ROUTING.md) for coordinator pairing and [MVP setup](docs/MVP_SETUP.md) for the email backend. Check microphone, playback and haptics on the physical Watch.

The app does not need an iPhone companion app, but these setup instructions use the Watch's paired iPhone for development pairing.

## Build checks

After installing watchOS platform support:

```sh
xcodebuild -project WatchStarter.xcodeproj -scheme WatchStarter \
  -destination 'generic/platform=watchOS Simulator' \
  -derivedDataPath build CODE_SIGNING_ALLOWED=NO build

xcodebuild -project WatchStarter.xcodeproj -scheme WatchStarter \
  -destination 'generic/platform=watchOS' \
  -derivedDataPath build CODE_SIGNING_ALLOWED=NO build
```

These compile checks do not prove signing, physical installation, or vibration. Verify those using the device checklist above.

## If the Watch does not appear

- Confirm it has completed setup with the iPhone, and both devices are unlocked.
- Pair the iPhone with Xcode first; enable Developer Mode and accept Trust on both devices.
- Confirm your Xcode supports the Watch's installed watchOS version. Check the version under the Watch's **Settings → General → About**.
- Hackathon guest Wi-Fi may block device discovery. Try a network that permits local device discovery, and keep the paired iPhone connected by cable.
- For a missing Watch simulator, install watchOS in **Xcode → Settings → Components**, then create/select a Watch simulator in the device manager.

Official references: [Watch setup](https://support.apple.com/en-us/109015), [Xcode device pairing](https://developer.apple.com/documentation/xcode/managing-your-simulated-and-physical-devices-in-device-hub), [Developer Mode](https://developer.apple.com/documentation/xcode/enabling-developer-mode-on-a-device), [signing and running](https://developer.apple.com/documentation/xcode/running-your-app-on-simulated-or-physical-devices).
