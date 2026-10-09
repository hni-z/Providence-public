import Foundation

@main
struct UnsupportedTargetAcceptance {
    static func main() {
        let blocked = [
            "On my Windows PC, open https://example.com.",
            "Open the browser on my iPhone.",
            "Using my Android phone, open the browser.",
            "On my Quest 3 headset, open the browser.",
            "Please use my Windows 11 laptop to open the browser.",
            "iPhone: open the browser.",
            "On my Linux laptop, open the browser.",
            "Open the browser on my iPad.",
        ]
        let allowedMac = [
            "On my Mac, open https://example.com in Safari.",
            "Open the Windows PC setup document on my Mac.",
            "Find the phrase \"on my iPhone\" in the project.",
            "Write a note saying open the browser on my Quest.",
            "Search for Linux laptop reviews on my Mac.",
        ]
        let allowedEmail = "Email Alex saying open the browser on my iPhone."
        var failures: [String] = []
        for text in blocked {
            if !VoiceTargetGate.hasUnsupportedTarget(text) || VoiceRoute.recognize(text) != .unsupportedTarget {
                failures.append("W06 explicit unsupported target was routable: \(text)")
            }
        }
        for text in allowedMac {
            if VoiceTargetGate.hasUnsupportedTarget(text) || VoiceRoute.recognize(text) != .mac {
                failures.append("W06 target/topic distinction rejected an ordinary Mac request: \(text)")
            }
        }
        if VoiceRoute.recognize(allowedEmail) != .email { failures.append("W06 email body target is content, not a device route") }
        if !failures.isEmpty { failures.forEach { print("FAIL: \($0)") }; exit(1) }
        print("W06 eight explicit non-Mac targets blocked, five Mac/topic cases and one email-body case allowed by actual gate/router.")
        print("Dispatch callsite inspection and physical zero-dispatch observation remain necessary; no multi-device support claimed.")
    }
}
