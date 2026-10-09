import Foundation
import WatchCoordinatorAdapter

enum MirroringRoutingTests {
    static func run(_ suite: inout TaskRoutingTests.Suite) throws {
        let now = Date(timeIntervalSince1970: 1_000)
        let target = IPhoneMirroringTarget(deviceID: "demo", chatID: "demo-chat", phoneID: "selected-iphone", phoneName: "Demo's iPhone")
        let chats = [try TaskRoutingTests.chat("demo-chat", deviceID: "demo")]
        let evidence: [String: Any] = [
            "schemaVersion": 1, "transport": "apple-iphone-mirroring", "appBundleId": "com.apple.ScreenContinuity",
            "deviceId": target.deviceID, "chatId": target.chatID, "phoneId": target.phoneID, "phoneName": target.phoneName,
            "sessionId": "session-one", "observedAt": 995, "expiresAt": 1_030,
            "configured": true, "appPresent": true, "phoneReachable": true, "authenticated": true,
            "identityVerified": true, "controllable": true, "effectVerified": true, "executable": true,
            "supportedActions": ["general", "browser", "messaging", "email"]
        ]
        func device(_ changes: [String: Any] = [:], platform: String? = "darwin", online: Bool = true) throws -> CoordinatorDevice {
            var value = evidence
            changes.forEach { value[$0.key] = $0.value }
            return try TaskRoutingTests.device("demo", name: "Demo's Mac", platform: platform, online: online,
                                               capabilities: ["iphoneMirroring": value])
        }
        func resolve(_ text: String, inventory: [CoordinatorDevice]? = nil, contexts: [CoordinatorChat]? = nil,
                     expected: IPhoneMirroringTarget? = target) throws -> TaskRouteSelection {
            try TaskRoutePlanner.resolve(text: text, devices: inventory ?? [try device()], chats: contexts ?? chats,
                                         defaultDeviceID: "demo", defaultChatID: "demo-chat", expectedMirroringTarget: expected, now: now)
        }
        func check(_ label: String, _ block: () throws -> Bool) {
            suite.count += 1
            do { if try !block() { suite.failures.append(label) } }
            catch { suite.failures.append("\(label): \(error)") }
        }
        func fails(_ label: String, _ expected: IPhoneMirroringError, _ block: () throws -> Void) {
            check(label) {
                do { try block(); return false }
                catch let error as IPhoneMirroringError { return error == expected }
            }
        }
        for (text, action) in [
            ("Open Safari on my iPhone", "browser"),
            ("On my iPhone’s search bar for IAN’s example domains, open IAN’s page and tell me whether example.com can be registered.", "browser"),
            ("On my iPhone, search Safari for IANA example domains, open IANA’s page, and tell me whether example.com can be registered.", "browser"),
            ("On my iPhone, search Safari for example.com and tell me if it can be registered", "browser"),
            ("Use my phone to open Safari", "browser"),
            ("Open Settings on Demo's iPhone", "general"),
            ("Open Settings on Demo’s phone", "general"),
            ("iPhone: open Safari", "browser"),
            ("Use iPhone Mirroring to open Safari", "browser"),
            ("Open Messages on my phone", "messaging"),
            ("Open iPhone messages", "messaging"),
            ("Send a phone message to Bob", "messaging"),
            ("Open Messages through my phone", "messaging"),
            ("Message Bob on my iPhone saying hello", "messaging"),
            ("Email Bob on my iPhone saying hello", "email"),
            ("Open Safari on Demo's iPhone using Demo's Mac", "browser")
        ] {
            check("Mirroring routes exact Demo target: \(text)") {
                let selection = try resolve(text)
                return selection.deviceID == target.deviceID && selection.chatID == target.chatID &&
                    selection.iphoneMirroring?.target == target && selection.iphoneMirroring?.sessionID == "session-one" &&
                    selection.action.rawValue == action && selection.deviceName.contains("via Demo's Mac")
            }
        }
        for text in ["Search for iPhone reviews", "Email Bob saying open Safari on my iPhone", "Don't use my phone, open Safari on my Mac"] {
            check("Phone data/negation never opts into Mirroring: \(text)") { try resolve(text).iphoneMirroring == nil }
        }
        for text in ["Open Safari on my Android", "Use my Android phone to open Chrome", "Open Safari on Alex's iPhone", "Alex's iPhone: open Safari", "Open my iPad", "Call Mom on my iPhone"] {
            suite.error("Unsupported never routes via Mirroring: \(text)", kind: .unavailable) { try resolve(text) }
        }
        for text in ["Unlock my phone", "Restart my phone", "Open Camera on my iPhone", "Take a picture on my iPhone", "Use the microphone on my iPhone", "Find the file on my iPhone"] {
            fails("Unsupported phone operation: \(text)", .unsupportedAction) { _ = try resolve(text) }
        }
        fails("No selected phone is setup", .notConfigured) { _ = try resolve("Open Safari on my phone", expected: nil) }
        fails("No native phone worker fallback", .macUnavailable) { _ = try resolve("Open Safari on my phone", inventory: [try device(platform: "ios")]) }
        fails("No unknown-platform exception for phone", .macUnavailable) { _ = try resolve("Open Safari on my phone", inventory: [try device(platform: nil)]) }
        fails("Offline selected Mac stays selected", .macUnavailable) { _ = try resolve("Open Safari on my phone", inventory: [try device(online: false)]) }
        fails("Exact chat unavailable", .chatUnavailable) { _ = try resolve("Open Safari on my phone", contexts: [try TaskRoutingTests.chat("other-chat", deviceID: "demo")]) }
        fails("Phone and foreign Mac conflict", .wrongTarget) { _ = try resolve("Open Safari on my phone using Alex's Mac") }
        fails("Negated selected Mac does not fallback", .wrongTarget) { _ = try resolve("Don't use Demo's Mac, open Safari on my phone") }
        fails("Missing configured host rejected", .macUnavailable) {
            _ = try resolve("Open Safari on my phone", expected: IPhoneMirroringTarget(deviceID: "other", chatID: "demo-chat", phoneID: "selected-iphone", phoneName: "Demo's iPhone"))
        }
        for (flag, failure) in [("configured", IPhoneMirroringError.notConfigured), ("appPresent", .appMissing),
                                ("phoneReachable", .phoneUnavailable), ("authenticated", .authenticationRequired),
                                ("identityVerified", .wrongTarget), ("controllable", .controlUnavailable),
                                ("effectVerified", .acceptanceRequired), ("executable", .controlUnavailable)] {
            fails("Readiness gate: \(flag)", failure) { _ = try resolve("Open Safari on my phone", inventory: [try device([flag: false])]) }
        }
        for key in ["deviceId", "chatId", "phoneId", "phoneName"] {
            fails("Evidence exact identity: \(key)", .wrongTarget) { _ = try resolve("Open Safari on my phone", inventory: [try device([key: "other"])]) }
        }
        for change: [String: Any] in [["expiresAt": 1_000], ["observedAt": 1_006], ["expiresAt": 1_060],
                                     ["observedAt": 930], ["observedAt": "995"], ["expiresAt": 994]] {
            fails("Expired/invalid clock fails closed", .staleEvidence) { _ = try resolve("Open Safari on my phone", inventory: [try device(change)]) }
        }
        for change: [String: Any] in [["schemaVersion": 2], ["schemaVersion": true], ["sessionId": "unsafe id"], ["transport": "simulator"]] {
            fails("Schema confusion fails closed", .invalidEvidence) { _ = try resolve("Open Safari on my phone", inventory: [try device(change)]) }
        }
        for change: [String: Any] in [["supportedActions": ["general"]], ["supportedActions": ["browser", "phoneCall"]], ["supportedActions": []]] {
            fails("Only proven action category can route", .unsupportedAction) { _ = try resolve("Open Safari on my phone", inventory: [try device(change)]) }
        }
        for claims: [String: Any] in [["phoneMirroring": true, "desktop": true], ["declaredCapabilities": ["iphoneMirroring": evidence]], ["iphoneMirroring": true]] {
            let claimed = try TaskRoutingTests.device("demo", name: "Demo's Mac", platform: "darwin", capabilities: claims)
            fails("Metadata cannot grant phone access", claims["iphoneMirroring"] == nil ? .notConfigured : .invalidEvidence) {
                _ = try resolve("Open Safari on my phone", inventory: [claimed])
            }
        }
        let route = try resolve("Open Safari on my phone").iphoneMirroring!
        check("Fresh same-session route revalidates") {
            try IPhoneMirroringPreflight.revalidate(route, devices: [try device()], chats: chats, now: now); return true
        }
        fails("Saved request cannot change session", .sessionChanged) {
            try IPhoneMirroringPreflight.revalidate(route, devices: [try device(["sessionId": "new-session"])], chats: chats, now: now)
        }
        let spoken = "Open Safari on my iPhone"
        let prompt = try VoiceTaskEnvelope.make(spoken, iphoneMirroring: route)
        let prepared = MacPreparedRequest(requestID: UUID(), text: prompt, chatID: target.chatID, deviceID: target.deviceID,
                                          spokenText: spoken, iphoneMirroring: route)
        check("Unknown outcome preserves exact request and phone binding") {
            let decoded = try JSONDecoder().decode(MacPreparedRequest.self, from: JSONEncoder().encode(prepared))
            return decoded == prepared
        }
        check("Mirroring envelope retains recovery, exact approval and concise speech") {
                prompt.contains("com.apple.ScreenContinuity") && prompt.contains("session-one") &&
                prompt.contains("same phone, account") &&
                prompt.contains("Never repeat an uncertain action") &&
                prompt.contains("Speech recovery:") && prompt.contains("at most 50 words") &&
                prompt.contains("Keep the specified sender, recipient, content and device") &&
                prompt.contains("never fabricate approval or weaken them") &&
                prompt.contains("selected Mac's owner holding the external GUI slot") &&
                prompt.hasSuffix("User request follows:\n" + spoken)
        }
        let normalPrompt = try VoiceTaskEnvelope.make(spoken)
        check("Ordinary envelope cannot grant phone access") { normalPrompt.contains("Do not claim phone access") }
        check("Fresh envelopes do not invoke a retired product tool") {
            !normalPrompt.contains("providence_request_decision") &&
                normalPrompt.contains("Applicable tool and platform permissions still apply") &&
                normalPrompt.contains("Never repeat an uncertain action") &&
                normalPrompt.hasSuffix("User request follows:\n" + spoken)
        }

        let old = try JSONDecoder().decode(MacPreparedRequest.self, from: Data(#"{"requestID":"00000000-0000-0000-0000-000000000001","text":"old","chatID":"demo-chat","deviceID":"demo"}"#.utf8))
        check("Old prepared request decodes without upgrading to phone access") { old.iphoneMirroring == nil }
        let config = ProvidenceCoordinatorConfiguration(baseURL: URL(string: "https://providence.hani.so")!, deviceID: "demo", chatID: "demo-chat", iphoneMirroringTarget: target)
        let configData = try JSONSerialization.data(withJSONObject: ["baseURL": "https://providence.hani.so", "deviceId": "demo", "chatId": "demo-chat",
                                                                   "iphoneMirroringTarget": ["deviceId": "demo", "chatId": "demo-chat", "phoneId": "selected-iphone", "phoneName": "Demo's iPhone"],
                                                                   "preferredChatIDsByDevice": ["demoPC": "demoPC-chat-3"]])
        check("Explicit public config target and optional per-device chat map decode") {
            let decoded = try ProvidenceCoordinatorConfiguration.decodeAndValidate(configData)
            return decoded.iphoneMirroringTarget == config.iphoneMirroringTarget && decoded.preferredChatIDsByDevice == ["demoPC": "demoPC-chat-3"]
        }
        let selectedTarget = IPhoneMirroringTarget(deviceID: "review-mac", chatID: "review-phone-chat", phoneID: "selected-phone", phoneName: "Review's iPhone")
        let binding: [String: Any] = [
            "schemaVersion": 1, "transport": "apple-iphone-mirroring", "appBundleId": "com.apple.ScreenContinuity",
            "status": "configured", "deviceId": selectedTarget.deviceID, "chatId": selectedTarget.chatID,
            "phoneId": selectedTarget.phoneID, "phoneName": selectedTarget.phoneName, "bindingEpoch": "epoch-one",
            "allowedActions": ["browser", "general"], "requiresLivePreflight": true, "grantsPermission": false,
        ]
        let selectedHost = try TaskRoutingTests.device("review-mac", name: "Review Mac", platform: "darwin", capabilities: ["iphoneMirroringBinding": binding])
        let selectedChats = [try TaskRoutingTests.chat("demo-chat", deviceID: "demo"), try TaskRoutingTests.chat("review-phone-chat", deviceID: "review-mac")]
        let configuredRoute = try TaskRoutePlanner.resolve(text: "Open Safari on my iPhone", devices: [try device(), selectedHost], chats: selectedChats,
                                                            defaultDeviceID: "demo", defaultChatID: "demo-chat", expectedMirroringTarget: selectedTarget, now: now)
        check("Configured binding can select a phone host distinct from default Mac") {
            configuredRoute.deviceID == "review-mac" && configuredRoute.chatID == "review-phone-chat" &&
                configuredRoute.iphoneMirroring?.sessionID == "epoch-one" && configuredRoute.deviceName.contains("via Review Mac")
        }
        check("Configured binding has no synthetic live readiness claim") {
            configuredRoute.iphoneMirroring?.sessionID == "epoch-one" && binding["requiresLivePreflight"] as? Bool == true &&
                binding["grantsPermission"] as? Bool == false
        }
        fails("Invalid binding blocks legacy readiness fallback", .invalidEvidence) {
            var invalidBinding = binding; invalidBinding["status"] = "revoked"
            let mixed = try TaskRoutingTests.device("review-mac", name: "Review Mac", platform: "darwin", capabilities: ["iphoneMirroringBinding": invalidBinding, "iphoneMirroring": evidence])
            _ = try TaskRoutePlanner.resolve(text: "Open Safari on my iPhone", devices: [mixed], chats: [try TaskRoutingTests.chat("review-phone-chat", deviceID: "review-mac")],
                                             defaultDeviceID: "demo", defaultChatID: "demo-chat", expectedMirroringTarget: selectedTarget, now: now)
        }
        fails("Saved configured route detects epoch change", .sessionChanged) {
            var changedBinding = binding; changedBinding["bindingEpoch"] = "epoch-two"
            let changedHost = try TaskRoutingTests.device("review-mac", name: "Review Mac", platform: "darwin", capabilities: ["iphoneMirroringBinding": changedBinding])
            try IPhoneMirroringPreflight.revalidate(configuredRoute.iphoneMirroring!, devices: [changedHost], chats: [try TaskRoutingTests.chat("review-phone-chat", deviceID: "review-mac")], now: now)
        }
        let demoPC = try TaskRoutingTests.device("demoPC", name: "DemoPC", platform: "linux", capabilities: ["browser": true])
        let demoPcChats = (1...5).map { try! TaskRoutingTests.chat("demoPC-chat-\($0)", deviceID: "demoPC") }
        let mapped = try TaskRoutePlanner.resolve(text: "Open Safari on DemoPC", devices: [try device(), demoPC], chats: chats + demoPcChats,
                                                   defaultDeviceID: "demo", defaultChatID: "demo-chat", preferredChatIDsByDevice: ["demoPC": "demoPC-chat-3"], now: now)
        check("Explicit nondefault chat mapping chooses one of five registered chats") { mapped.deviceID == "demoPC" && mapped.chatID == "demoPC-chat-3" }
        suite.error("Wrong explicit nondefault chat mapping never chooses another chat", kind: .unavailable) {
            try TaskRoutePlanner.resolve(text: "Open Safari on DemoPC", devices: [try device(), demoPC], chats: chats + demoPcChats,
                                         defaultDeviceID: "demo", defaultChatID: "demo-chat", preferredChatIDsByDevice: ["demoPC": "missing-chat"], now: now)
        }
        var offlineDemoPCChats = demoPcChats
        offlineDemoPCChats[2] = try TaskRoutingTests.chat("demoPC-chat-3", deviceID: "demoPC", online: false)
        suite.error("Offline explicit nondefault chat mapping never chooses another chat", kind: .unavailable) {
            try TaskRoutePlanner.resolve(text: "Open Safari on DemoPC", devices: [try device(), demoPC], chats: chats + offlineDemoPCChats,
                                         defaultDeviceID: "demo", defaultChatID: "demo-chat", preferredChatIDsByDevice: ["demoPC": "demoPC-chat-3"], now: now)
        }
        check("All typed errors have concise text plus recovery") {
            let errors: [IPhoneMirroringError] = [.notConfigured, .appMissing, .phoneUnavailable, .authenticationRequired, .wrongTarget,
                                                .controlUnavailable, .acceptanceRequired, .invalidEvidence, .staleEvidence,
                                                .unsupportedAction, .macUnavailable, .chatUnavailable, .sessionChanged]
            return errors.allSatisfy { ($0.errorDescription?.count ?? 500) < 100 && !($0.recoverySuggestion ?? "").isEmpty }
        }
    }
}
