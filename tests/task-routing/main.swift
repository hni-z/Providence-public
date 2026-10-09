import Foundation
import WatchCoordinatorAdapter

@main
struct TaskRoutingTests {
    static func main() throws {
        var suite = Suite()
        let mac = try device("home", name: "Home Mac", platform: "darwin", capabilities: ["files": true, "shell": true, "browser": true])
        let rich = try device("studio", name: "Studio", platform: "macOS", capabilities: ["files": true, "shell": true, "browser": true, "desktop": true])
        let windows = try device("work", name: "Workstation", platform: "win32", capabilities: ["files": true, "shell": true, "browser": true])
        let linux = try device("lab", name: "Lab", platform: "linux", capabilities: ["files": true, "shell": true])
        let devices = [mac, rich, windows, linux]
        let chats = try devices.map { try chat("chat-" + $0.id, deviceID: $0.id) }

        func resolve(_ text: String, _ inventory: [CoordinatorDevice] = devices, _ contexts: [CoordinatorChat] = chats,
                     defaultID: String = "home", defaultChat: String = "chat-home",
                     aliases: [String: String] = [:]) throws -> TaskRouteSelection {
            try TaskRoutePlanner.resolve(text: text, devices: inventory, chats: contexts,
                                         defaultDeviceID: defaultID, defaultChatID: defaultChat, deviceAliasesByID: aliases)
        }

        for text in ["Summarize this idea", "Please explain recursion", "Compare iPhone and Quest features", "Explain how to call the API", "Call the function calculateTotal"] {
            suite.route(text, device: "home", action: .general) { try resolve(text) }
        }
        for text in ["Search for iPhone reviews", "Search for iPad prices", "Search for Linux tutorials", "Open Safari", "Please open Chrome on my Mac", "Could you search for reviews on iPhone?", "Look up information on iPhone", "Open https://example.com", "Use my Mac to open Safari", "Mac: open Safari", "On my Mac, open Safari"] {
            suite.route(text, device: "home", action: .browser) { try resolve(text) }
        }
        for text in ["Find the budget file", "Open my Downloads folder", "Rename the report.pdf file", "Search for files about iPhone", "Run the tests", "Edit the codebase on my Mac"] {
            suite.route(text, device: "home", action: .files) { try resolve(text) }
        }
        for text in [
            "Email Bob saying open Safari on my iPhone",
            "Send an email to Bob about opening Safari on my iPhone",
            "Write an email with the subject Open Safari on my iPhone",
            "Email Bob: open Safari on my iPhone",
            "Draft an email to Bob with the body restart my phone",
            "Email Bob to open Safari on my iPhone",
            "Email Bob saying call Mom",
            "Mac: email Bob saying open Safari on my iPhone",
            "Send an email to Bob saying use my Windows PC"
        ] {
            suite.route(text, device: "home", action: .email) { try resolve(text) }
        }
        for text in ["Text Mom saying use my iPhone", "Message Alex that I am using my iPhone", "Tell Bob to open Safari on my iPhone", "Send Mom a text saying call Dad", "Open Messages on my Mac"] {
            suite.route(text, device: "home", action: .messaging) { try resolve(text) }
        }
        suite.route("Recipient message keeps messaging classification", device: "home", action: .messaging) {
            try resolve("Tell Demo that my iPhone's search bar found example.com")
        }
        for text in ["Search for \"open Safari on my iPhone\"", "Search for “open Safari on my iPhone”", "Search for `open Safari on my iPhone`", "Search for 'open Safari on my iPhone'", "Search for \"open Safari on my iPhone", "Search for iPhone reviews saying open it on my iPhone"] {
            suite.route(text, device: "home", action: .browser) { try resolve(text) }
        }
        for text in ["Open Safari on my iPhone", "Open Safari using my phone", "Use my Android phone to open Chrome", "Open Safari on my iPad", "Play Beat Saber on Quest 3", "iPhone, open Safari", "iPad: open Safari", "Open my iPhone", "Restart my phone", "Email Bob on my iPhone saying hello"] {
            suite.error(text, kind: .unavailable) { try resolve(text) }
        }
        for text in ["Call Mom", "Please dial 5551234567", "Make a phone call to Dad", "Start a FaceTime call", "FaceTime Mom", "Call Mom on my Mac"] {
            suite.error(text, kind: .unavailable, containing: "Phone calls") { try resolve(text) }
        }
        for (text, id, action) in [("Open Chrome on my Windows PC", "work", TaskRouteAction.browser), ("Find my file using Linux", "lab", .files), ("Use my Linux computer to run the tests", "lab", .files), ("Open Safari on Studio", "studio", .browser), ("Open Safari using Workstation", "work", .browser)] {
            suite.route(text, device: id, action: action) { try resolve(text) }
        }
        for text in [
            "Open the video twenty hours from the downloads folder of the Windows and play it.",
            "Search my Windows computer for the file 20 hours and open that file",
            "Search Windows for the file 20 hours",
            "Search for the file 20 hours in Windows",
            "Find the report file in Windows and open it",
            "Locate the backup from the documents folder of the Windows",
            "Open the video from the downloads of Windows",
            "Open the Windows Downloads folder",
            "Open Windows's Downloads folder"
        ] {
            suite.route("Explicit filesystem Windows: \(text)", device: "work", action: .files) { try resolve(text) }
        }
        suite.error("Explicit filesystem Windows offline never falls back", kind: .unavailable, containing: "offline") {
            try resolve("Search Windows for the file 20 hours", [mac, try device("work", name: "Workstation", platform: "win32", online: false, capabilities: ["files": true])])
        }
        suite.error("Locked Mac conflicts with spoken filesystem Windows", kind: .clarification) {
            try TaskRoutePlanner.resolveLocked(text: "Search Windows for the file 20 hours", lockedDeviceID: "home", lockedChatID: "chat-home", devices: devices, chats: chats)
        }
        suite.error("Missing Windows in the exact incident never uses the Mac", kind: .unavailable) {
            try resolve("Open the video twenty hours from the downloads folder of the Windows and play it.", [mac])
        }
        for text in ["Open the video from the downloads folder of Alex's PC", "Search Alex's PC for the file 20 hours"] {
            suite.error("Unregistered filesystem owner: \(text)", kind: .unavailable) { try resolve(text) }
        }
        suite.route("Named filesystem owner", device: "work", action: .files) {
            try resolve("Open the video from the downloads folder of DemoPC", aliases: ["work": "DemoPC"])
        }
        suite.route("Linux filesystem owner", device: "lab", action: .files) {
            try resolve("Open the file from the downloads folder of Linux")
        }
        suite.route("Configured Mac filesystem owner", device: "home", action: .files) {
            try resolve("Open the file from the downloads folder of my Mac")
        }
        for text in [
            "Search Windows tutorials",
            "Find Windows installers online",
            "Search for \"Windows files\" tutorials",
            "Search for Windows Downloads folder tutorials",
            "Search for file recovery information on Windows",
            "Find a file about documents folder of Windows",
            "Open the file named \"downloads folder of the Windows\"",
            "Email Bob saying search Windows for the file 20 hours"
        ] {
            let action: TaskRouteAction = text.hasPrefix("Email") ? .email :
                (text.hasPrefix("Find") && !text.contains("file about") ? .general :
                    (text.hasPrefix("Open") || text.contains("folder") || text.contains("file recovery") || text.contains("file about") ? .files : .browser))
            suite.route("Windows topic/data is not a destination: \(text)", device: "home", action: action) { try resolve(text) }
        }
        suite.error("PC is ambiguous", kind: .clarification) { try resolve("Find the file on my PC") }
        suite.error("Two explicit families", kind: .unavailable) { try resolve("Open Safari on my Mac and on my Windows PC") }
        suite.error("Two different action classes", kind: .clarification) { try resolve("Open Safari and rename the file") }
        suite.route("Negative phone is excluded", device: "home", action: .browser) { try resolve("Don't use my iPhone, open Safari on my Mac") }
        suite.route("Inline negative phone is excluded", device: "home", action: .browser) { try resolve("Open Safari not on my iPhone") }
        suite.route("Negative default is excluded", device: "studio", action: .browser) { try resolve("Don't use Home Mac, open Safari") }
        suite.error("Only a negation", kind: .clarification) { try resolve("Do not open Safari on my iPhone") }
        suite.error("Conflicting negation", kind: .clarification) { try resolve("Do not use my Mac, open Safari on my Mac") }

        let offline = try device("work", name: "Workstation", platform: "win32", online: false, capabilities: ["browser": true])
        suite.error("Explicit offline does not fallback", kind: .unavailable, containing: "offline") { try resolve("Open Chrome on my Windows PC", [mac, offline]) }
        let offlineMac = try device("home", name: "Home Mac", platform: "darwin", online: false, capabilities: ["browser": true])
        suite.error("Explicit configured Mac offline never changes Mac", kind: .unavailable, containing: "offline") { try resolve("Open Safari on my Mac", [offlineMac, rich]) }
        suite.error("Unregistered possessive Mac never defaults", kind: .unavailable) { try resolve("Open Safari on Alex's Mac", devices) }
        let demo = try device("demo", name: "Demo's Mac", platform: "darwin", capabilities: ["browser": true])
        suite.route("Registered possessive exact name", device: "demo", action: .browser) { try resolve("Open Safari on Demo's Mac", [mac, demo], chats + [try chat("chat-demo", deviceID: "demo")]) }
        suite.route("Curly apostrophe exact name", device: "demo", action: .browser) { try resolve("Open Safari on Demo’s Mac", [mac, demo], chats + [try chat("chat-demo", deviceID: "demo")]) }
        let sameName = try device("studio-two", name: "Studio", platform: "darwin", capabilities: ["browser": true])
        suite.error("Duplicate display names clarify", kind: .clarification) { try resolve("Open Safari on Studio", [mac, rich, sameName], chats + [try chat("chat-studio-two", deviceID: "studio-two")]) }
        suite.route("Exact configured alias", device: "work", action: .browser) {
            try resolve("Open Chrome on DemoPC", devices, chats, aliases: ["work": "DemoPC"])
        }
        suite.route("Locked target stays exact for generic speech", device: "work", action: .browser) {
            try TaskRoutePlanner.resolveLocked(text: "Open Chrome", lockedDeviceID: "work", lockedChatID: "chat-work",
                                               devices: devices, chats: chats, deviceAliasesByID: ["work": "DemoPC"])
        }
        suite.error("Locked target rejects a different spoken alias", kind: .clarification) {
            try TaskRoutePlanner.resolveLocked(text: "Open Chrome on DemoPC", lockedDeviceID: "home", lockedChatID: "chat-home",
                                               devices: devices, chats: chats, deviceAliasesByID: ["work": "DemoPC"])
        }
        suite.error("Duplicate aliases clarify safely", kind: .unavailable) {
            try resolve("Open Chrome", devices, chats, aliases: ["home": "Desk", "work": "desk"])
        }
        suite.error("Explicit unregistered does not fallback", kind: .unavailable) { try resolve("Open Chrome on Linux", [mac]) }
        suite.error("Explicit missing chat does not fallback", kind: .unavailable, containing: "chat") { try resolve("Open Safari on Studio", devices, chats.filter { $0.deviceID != "studio" }) }
        let extraChat = try chat("other-home", deviceID: "home")
        suite.route("Default chat preserved", device: "home", chat: "chat-home", action: .general) { try resolve("Explain this idea", devices, chats + [extraChat]) }
        suite.error("Missing default chat never substitutes another chat", kind: .unavailable, containing: "chat") { try resolve("Explain this idea on my Mac", [mac], [extraChat]) }
        suite.error("Wrong-device default chat rejected", kind: .unavailable, containing: "chat") { try resolve("Explain this idea", [mac], [try chat("chat-home", deviceID: "wrong")]) }
        suite.error("Offline default chat rejected", kind: .unavailable, containing: "chat") { try resolve("Explain this idea", [mac], [try chat("chat-home", deviceID: "home", online: false)]) }
        suite.error("Nondefault multiple chats clarify", kind: .clarification, containing: "chat") { try resolve("Open Safari on Studio", devices, chats + [try chat("other-studio", deviceID: "studio")]) }
        suite.route("Offline extra chats ignored", device: "studio", action: .browser) { try resolve("Open Safari on Studio", devices, chats + [try chat("other-studio", deviceID: "studio", online: false)]) }

        let sparse = try device("home", name: "Trusted", platform: "darwin", capabilities: [:])
        for (text, action) in [("Explain recursion", TaskRouteAction.general), ("Email Bob saying hello", .email), ("Text Mom saying hello", .messaging)] {
            suite.route("Trusted sparse \(action)", device: "home", action: action) { try resolve(text, [sparse]) }
        }
        suite.route("Trusted unverified browser fallback", device: "home", action: .browser, reason: "unverified") { try resolve("Open Safari", [sparse]) }
        suite.route("Verified browser outranks unverified fallback", device: "studio", action: .browser) { try resolve("Open Safari", [sparse, rich]) }
        suite.route("Explicit Mac has bounded unverified fallback", device: "home", action: .browser, reason: "unverified") { try resolve("Open Safari on Home Mac", [try device("home", name: "Home Mac", platform: "darwin", capabilities: [:]), windows]) }
        suite.route("Explicit Mac does not prefer a verified different Mac", device: "home", action: .browser, reason: "unverified") { try resolve("Open Safari on my Mac", [sparse, rich]) }
        suite.error("Files require evidence", kind: .unavailable, containing: "capabilities") { try resolve("Rename the file", [sparse]) }
        suite.route("Default preferred over richer capabilities", device: "home", action: .browser) { try resolve("Open Safari", [mac, rich]) }
        suite.route("Unique capable fallback", device: "studio", action: .files) { try resolve("Find the file", [sparse, rich]) }
        suite.route("Weighted browser choice", device: "studio", action: .browser) { try resolve("Open Safari", [rich, windows], defaultID: "missing") }
        suite.error("Equal capability scores clarify", kind: .clarification) { try resolve("Open Safari", [mac, windows], defaultID: "missing") }
        suite.error("Equal scores independent of order", kind: .clarification) { try resolve("Open Safari", [windows, mac], defaultID: "missing") }
        suite.error("No inventory", kind: .unavailable) { try resolve("Open Safari", [], []) }
        suite.error("Duplicate device identities", kind: .unavailable) { try resolve("Open Safari", [mac, mac]) }
        suite.error("Duplicate chat identities", kind: .unavailable) { try resolve("Open Safari", [mac], chats + chats) }

        let unknown = try device("home", name: "Paired computer", platform: nil, capabilities: [:])
        suite.route("Trusted missing platform Mac", device: "home", action: .general) { try resolve("Explain recursion on my Mac", [unknown]) }
        suite.error("Missing platform cannot become Windows", kind: .unavailable) { try resolve("Explain recursion on my Windows PC", [unknown]) }
        let falseWindows = try device("impostor", name: "Windows PC", platform: "darwin", capabilities: ["browser": true])
        suite.error("Display name is not Windows platform", kind: .unavailable) { try resolve("Open Chrome on my Windows PC", [falseWindows]) }
        let mirrored = try device("home", name: "iPhone", platform: "ios", capabilities: ["phoneMirroring": true, "browser": true, "files": true])
        suite.error("PhoneMirroring cannot grant execution", kind: .unavailable) { try resolve("Open Safari", [mirrored]) }
        suite.error("Named iOS platform cannot execute", kind: .unavailable) { try resolve("Open Safari on home", [mirrored]) }
        let claimed = try device("claim", name: "Cloud model", platform: "linux", capabilities: ["model": "computer-use", "supportsComputerUse": true, "declaredCapabilities": ["browser": true, "desktop": true]])
        suite.error("Model and declarations are not capability evidence", kind: .unavailable) { try resolve("Open Chrome on Linux", [claimed], [try chat("claim-chat", deviceID: "claim")]) }
        let stringCaps = try device("string", name: "String caps", platform: "linux", capabilities: ["browser": "true", "files": 1, "desktop": ["enabled": true]])
        suite.error("Only boolean evidence counts", kind: .unavailable) { try resolve("Open Chrome on Linux", [stringCaps], [try chat("string-chat", deviceID: "string")]) }
        suite.error("Empty request", kind: .clarification) { try resolve(" ") }
        suite.error("Null byte", kind: .clarification) { try resolve("Open\0Safari") }
        suite.error("Oversize request", kind: .clarification) { try resolve(String(repeating: "a", count: 8001)) }
        suite.error("Quoted-only command", kind: .clarification) { try resolve("\"open Safari\"") }

        try MirroringRoutingTests.run(&suite)
        suite.finish()
    }

    static func device(_ id: String, name: String, platform: String?, online: Bool = true, capabilities: [String: Any]) throws -> CoordinatorDevice {
        var value: [String: Any] = ["id": id, "name": name, "local": false, "online": online,
                                    "connectionState": online ? "online" : "offline", "capabilities": capabilities]
        if let platform { value["platform"] = platform }
        return try JSONDecoder().decode(CoordinatorDevice.self, from: JSONSerialization.data(withJSONObject: value))
    }

    static func chat(_ id: String, deviceID: String, online: Bool = true) throws -> CoordinatorChat {
        let value: [String: Any] = ["id": id, "name": id, "deviceId": deviceID, "threadId": "thread-" + id, "online": online]
        return try JSONDecoder().decode(CoordinatorChat.self, from: JSONSerialization.data(withJSONObject: value))
    }

    struct Suite {
        enum Kind { case clarification, unavailable }
        var count = 0
        var failures: [String] = []

        mutating func route(_ label: String, device: String, chat: String? = nil, action: TaskRouteAction, reason: String? = nil,
                            _ resolve: () throws -> TaskRouteSelection) {
            count += 1
            do {
                let result = try resolve()
                guard result.deviceID == device, result.chatID == (chat ?? "chat-" + device), result.action == action,
                      !result.deviceName.isEmpty, !result.reason.isEmpty,
                      reason.map({ result.reason.contains($0) }) ?? true else {
                    failures.append("\(label): unexpected selection \(result)"); return
                }
            } catch { failures.append("\(label): \(error)") }
        }

        mutating func error(_ label: String, kind: Kind, containing: String? = nil, _ resolve: () throws -> TaskRouteSelection) {
            count += 1
            do { failures.append("\(label): unexpectedly selected \(try resolve())") }
            catch let error as TaskRouteError {
                let matches: Bool
                switch (kind, error) {
                case (.clarification, .clarification), (.unavailable, .unavailable): matches = true
                default: matches = false
                }
                if !matches || !(containing.map { error.localizedDescription.contains($0) } ?? true) {
                    failures.append("\(label): unexpected error \(error)")
                }
            } catch let error as IPhoneMirroringError {
                if kind != .unavailable || !(containing.map { error.localizedDescription.contains($0) } ?? true) {
                    failures.append("\(label): unexpected mirroring error \(error)")
                }
            } catch { failures.append("\(label): unexpected error \(error)") }
        }

        func finish() {
            failures.forEach { print("FAIL: \($0)") }
            print("Task routing: \(count - failures.count)/\(count) checks passed.")
            if !failures.isEmpty { exit(1) }
        }
    }
}
