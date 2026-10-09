import Foundation
import WatchCoordinatorAdapter

enum TaskRouteAction: String, Codable, Equatable, Sendable {
    case general, browser, files, messaging, email, phoneCall
}

struct TaskRouteSelection: Equatable, Sendable {
    let deviceID: String
    let chatID: String
    let deviceName: String
    let action: TaskRouteAction
    let reason: String
    var iphoneMirroring: IPhoneMirroringRoute? = nil
}

enum TaskRouteError: LocalizedError, Equatable {
    case clarification(String)
    case unavailable(String)

    var errorDescription: String? {
        switch self {
        case let .clarification(message), let .unavailable(message): return message
        }
    }
}

/// A deterministic UX routing policy, not an authorization or execution grant.
/// Input must be a fresh registered inventory. The caller persists the returned
/// exact IDs and revalidates that same device/chat before direct submission.
enum TaskRoutePlanner {
    /// A locked picker choice is an exact device/chat binding. Speech may name
    /// that same computer, but it cannot make the request fall back elsewhere.
    static func resolveLocked(
        text: String,
        lockedDeviceID: String,
        lockedChatID: String,
        devices: [CoordinatorDevice],
        chats: [CoordinatorChat],
        expectedMirroringTarget: IPhoneMirroringTarget? = nil,
        preferredChatIDsByDevice: [String: String] = [:],
        deviceAliasesByID: [String: String] = [:]
    ) throws -> TaskRouteSelection {
        let request = try Request(text: text.trimmingCharacters(in: .whitespacesAndNewlines), devices: devices,
                                  phoneName: expectedMirroringTarget?.phoneName, deviceAliasesByID: deviceAliasesByID)
        let resolved = try resolve(text: text, devices: devices, chats: chats, defaultDeviceID: lockedDeviceID,
                                   defaultChatID: lockedChatID, expectedMirroringTarget: expectedMirroringTarget,
                                   preferredChatIDsByDevice: preferredChatIDsByDevice, deviceAliasesByID: deviceAliasesByID)
        if request.targets.isEmpty && resolved.deviceID != lockedDeviceID {
            guard let device = devices.first(where: { $0.id == lockedDeviceID && $0.online }),
                  chats.contains(where: { $0.id == lockedChatID && $0.deviceID == lockedDeviceID && $0.online }) else {
                throw TaskRouteError.unavailable("The locked computer or conversation is offline. Nothing was routed elsewhere.")
            }
            return TaskRouteSelection(deviceID: lockedDeviceID, chatID: lockedChatID, deviceName: displayName(device),
                                      action: resolved.action, reason: "Using the locked computer and conversation.")
        }
        guard resolved.deviceID == lockedDeviceID, resolved.chatID == lockedChatID else {
            throw TaskRouteError.clarification("Your spoken computer conflicts with the locked selection. Record a corrected request.")
        }
        return resolved
    }

    static func resolve(
        text: String,
        devices: [CoordinatorDevice],
        chats: [CoordinatorChat],
        defaultDeviceID: String,
        defaultChatID: String,
        expectedMirroringTarget: IPhoneMirroringTarget? = nil,
        preferredChatIDsByDevice: [String: String] = [:],
        deviceAliasesByID: [String: String] = [:],
        now: Date = Date()
    ) throws -> TaskRouteSelection {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, trimmed.count <= 8000, !trimmed.contains("\0") else {
            throw TaskRouteError.clarification("Say a request of up to 8,000 characters.")
        }
        // Conflicting inventory identities must never be resolved by array order.
        guard Set(devices.map(\.id)).count == devices.count,
              Set(chats.map(\.id)).count == chats.count,
              preferredChatIDsByDevice.allSatisfy({ IPhoneMirroringTarget.validID($0.key) && IPhoneMirroringTarget.validID($0.value) }),
              deviceAliasesByID.allSatisfy({ IPhoneMirroringTarget.validID($0.key) && validAlias($0.value) }),
              Set(deviceAliasesByID.values.map { $0.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() }).count == deviceAliasesByID.count else {
            throw TaskRouteError.unavailable("Device information changed. Refresh devices and try again.")
        }

        let request = try Request(text: trimmed, devices: devices, phoneName: expectedMirroringTarget?.phoneName,
                                  deviceAliasesByID: deviceAliasesByID)
        if request.action == .phoneCall {
            throw TaskRouteError.unavailable("Phone calls are not available yet. No call was placed.")
        }
        if let unsupported = request.targets.first(where: \.isUnsupported) {
            throw TaskRouteError.unavailable("Execution on \(unsupported.label) is not available yet. Choose a registered computer.")
        }

        if request.targets.contains(.phone) {
            guard !request.unsupportedPhoneAction else { throw IPhoneMirroringError.unsupportedAction }
            guard let target = expectedMirroringTarget else { throw IPhoneMirroringError.notConfigured }
            // The explicit phone host/chat is independent of the default Watch
            // route; its exact registry binding below remains mandatory.
            guard let mac = devices.first(where: { $0.id == target.deviceID }) else {
                throw IPhoneMirroringError.macUnavailable
            }
            guard request.targets.filter({ $0 != .phone }).allSatisfy({ $0.matches(mac, defaultDeviceID: defaultDeviceID) }),
                  !request.exclusions.contains(where: { $0.matches(mac, defaultDeviceID: defaultDeviceID) }) else {
                throw IPhoneMirroringError.wrongTarget
            }
            let route = try IPhoneMirroringPreflight.validate(target: target, devices: devices, chats: chats,
                                                            action: request.action.rawValue, now: now)
            return TaskRouteSelection(deviceID: target.deviceID, chatID: target.chatID,
                                      deviceName: "\(target.phoneName) via \(displayName(mac))", action: request.action,
                                      reason: "Using the selected physical iPhone through iPhone Mirroring on its configured Mac.",
                                      iphoneMirroring: route)
        }

        var targetDevices = devices.filter { device in
            !request.exclusions.contains { $0.matches(device, defaultDeviceID: defaultDeviceID) } &&
            request.targets.allSatisfy { $0.matches(device, defaultDeviceID: defaultDeviceID) }
        }
        // A generic explicit target that identifies the configured computer
        // remains bound to it even when it is offline or lacks capability.
        if !request.targets.isEmpty, let configured = targetDevices.first(where: { $0.id == defaultDeviceID }) {
            targetDevices = [configured]
        }
        if !request.targets.isEmpty && targetDevices.isEmpty {
            let label = request.targets.map(\.label).joined(separator: " and ")
            throw TaskRouteError.unavailable("No registered computer matches \(label). Choose an available device.")
        }

        let online = targetDevices.filter { $0.online && Platform($0.platform).isComputerOrUnknown }
        if online.isEmpty {
            throw TaskRouteError.unavailable(request.targets.isEmpty
                ? "No eligible computer is online. Connect a registered computer and try again."
                : "The requested computer is offline or unavailable. Nothing was routed to another device.")
        }

        // The saved default chat is an exact context binding. A different chat
        // on that device cannot silently replace a missing/offline saved chat.
        func availableChats(_ device: CoordinatorDevice) -> [CoordinatorChat] {
            chats.filter {
                guard $0.deviceID == device.id, $0.online else { return false }
                if device.id == defaultDeviceID { return $0.id == defaultChatID }
                if let preferred = preferredChatIDsByDevice[device.id] { return $0.id == preferred }
                return true
            }
        }

        let candidates = online.compactMap { device -> Candidate? in
            guard let score = capabilityScore(request.action, device: device, defaultDeviceID: defaultDeviceID),
                  !availableChats(device).isEmpty else { return nil }
            return Candidate(device: device, score: score, browserUnverified: false)
        }

        let selected: Candidate
        if let preferred = candidates.first(where: { $0.device.id == defaultDeviceID }) {
            selected = preferred
        } else if let bestScore = candidates.map(\.score).max() {
            let best = candidates.filter { $0.score == bestScore }
            guard best.count == 1 else {
                throw TaskRouteError.clarification("Which computer: \(names(best.map(\.device)))?")
            }
            selected = best[0]
        } else if request.action == .browser,
                  let trusted = online.first(where: { isTrustedDefault($0, defaultDeviceID: defaultDeviceID) }),
                  !availableChats(trusted).isEmpty {
            // The configured Mac is trusted for general Codex requests. Absent
            // browser evidence may still allow its real tools to attempt work;
            // this exception never enables arbitrary cross-device fallback.
            selected = Candidate(device: trusted, score: 0, browserUnverified: true)
        } else {
            let hasCapableDevice = online.contains {
                capabilityScore(request.action, device: $0, defaultDeviceID: defaultDeviceID) != nil ||
                (request.action == .browser && isTrustedDefault($0, defaultDeviceID: defaultDeviceID))
            }
            if hasCapableDevice {
                throw TaskRouteError.unavailable("The selected computer has no available chat. Restore its configured chat or choose a computer with an online chat.")
            }
            throw TaskRouteError.unavailable("No eligible computer reports the capabilities for this \(request.action.rawValue) request.")
        }

        let choices = availableChats(selected.device)
        guard choices.count == 1 else {
            throw TaskRouteError.clarification("Which chat on \(displayName(selected.device))? Choose one in the app before retrying.")
        }
        let context = selected.device.id == defaultDeviceID ? "Using your configured chat." :
            (preferredChatIDsByDevice[selected.device.id] == nil ? "Using its only online chat." : "Using its configured chat.")
        let reason: String
        if selected.browserUnverified {
            reason = "Using your trusted configured Mac. Browser execution is unverified; its tools and permissions determine availability. \(context)"
        } else if !request.targets.isEmpty {
            reason = "Matched your explicit computer target for \(request.action.rawValue). \(context)"
        } else if selected.device.id == defaultDeviceID {
            reason = "Preferred your configured computer for \(request.action.rawValue). \(context)"
        } else {
            reason = "Best available capability match for \(request.action.rawValue). \(context)"
        }
        return TaskRouteSelection(deviceID: selected.device.id, chatID: choices[0].id,
                                  deviceName: displayName(selected.device), action: request.action, reason: reason)
    }

    private struct Candidate {
        let device: CoordinatorDevice
        let score: Int
        let browserUnverified: Bool
    }

    private enum Platform {
        case mac, windows, linux, phone, tablet, quest, unknown, other

        init(_ value: String?) {
            switch value?.lowercased().trimmingCharacters(in: .whitespacesAndNewlines) ?? "" {
            case "darwin", "macos", "mac", "osx", "os x": self = .mac
            case "win32", "windows", "win64": self = .windows
            case "linux": self = .linux
            case "ios", "iphone", "android": self = .phone
            case "ipados", "ipad": self = .tablet
            case "quest", "meta quest", "horizon os", "horizonos": self = .quest
            case "": self = .unknown
            default: self = .other
            }
        }

        var isComputerOrUnknown: Bool {
            switch self { case .mac, .windows, .linux, .unknown: return true; default: return false }
        }
    }

    private static func isTrustedDefault(_ device: CoordinatorDevice, defaultDeviceID: String) -> Bool {
        device.id == defaultDeviceID && [Platform.mac, .unknown].contains(Platform(device.platform))
    }

    private static func capabilityScore(_ action: TaskRouteAction, device: CoordinatorDevice, defaultDeviceID: String) -> Int? {
        guard Platform(device.platform).isComputerOrUnknown else { return nil }
        // /v1/devices supplies EFFECTIVE browser/desktop booleans. Do not read
        // declaredCapabilities, model support, phoneMirroring, or nested claims.
        // The explicit iPhone branch above has a separate, exact readiness gate.
        guard case let .object(values) = device.capabilities ?? .object([:]) else {
            return isTrustedDefault(device, defaultDeviceID: defaultDeviceID) &&
                [.general, .email, .messaging].contains(action) ? 1 : nil
        }
        func has(_ key: String) -> Bool { values[key] == .bool(true) }
        func weighted(_ weights: [(String, Int)]) -> Int {
            weights.reduce(0) { $0 + (has($1.0) ? $1.1 : 0) }
        }
        switch action {
        case .browser:
            return has("browser") ? weighted([("browser", 100), ("desktop", 20), ("files", 5)]) : nil
        case .files:
            return has("files") ? weighted([("files", 100), ("shell", 20), ("desktop", 5)]) : nil
        case .email, .messaging:
            if isTrustedDefault(device, defaultDeviceID: defaultDeviceID) { return 1 }
            return has("desktop") || has("browser")
                ? weighted([("desktop", 100), ("browser", 60), ("shell", 5)]) : nil
        case .general:
            if isTrustedDefault(device, defaultDeviceID: defaultDeviceID) { return 1 }
            let score = weighted([("shell", 100), ("files", 60), ("desktop", 40), ("browser", 20)])
            return score > 0 ? score : nil
        case .phoneCall:
            return nil
        }
    }

    private enum Target: Equatable {
        case mac, windows, linux, pc, phone, android, tablet, quest
        case named(id: String, name: String)
        case unregistered(String)

        var isUnsupported: Bool { [.android, .tablet, .quest].contains(self) }
        var label: String {
            switch self {
            case .mac: return "your Mac"
            case .windows: return "your Windows computer"
            case .linux: return "your Linux computer"
            case .pc: return "your PC"
            case .phone: return "your phone"
            case .android: return "your Android phone"
            case .tablet: return "your iPad"
            case .quest: return "your Quest"
            case let .named(_, name): return name
            case let .unregistered(name): return name
            }
        }

        func matches(_ device: CoordinatorDevice, defaultDeviceID: String) -> Bool {
            switch self {
            case .mac: return Platform(device.platform) == .mac || isTrustedDefault(device, defaultDeviceID: defaultDeviceID)
            case .windows: return Platform(device.platform) == .windows
            case .linux: return Platform(device.platform) == .linux
            case .pc: return [.windows, .linux].contains(Platform(device.platform))
            case .phone, .android: return Platform(device.platform) == .phone
            case .tablet: return Platform(device.platform) == .tablet
            case .quest: return Platform(device.platform) == .quest
            case let .named(id, _): return device.id == id
            case .unregistered: return false
            }
        }
    }

    private struct Request {
        let action: TaskRouteAction
        let targets: [Target]
        let exclusions: [Target]
        let unsupportedPhoneAction: Bool

        init(text: String, devices: [CoordinatorDevice], phoneName: String?, deviceAliasesByID: [String: String]) throws {
            var command = text.lowercased().replacingOccurrences(of: "’", with: "'")
            // An unclosed quote also protects the remainder as data. Possessive
            // apostrophes in names (Demo's Mac) are not opening quotes.
            command = replacing(#""(?:[^"\\]|\\.)*(?:"|$)|“[^”]*(?:”|$)|`[^`]*(?:`|$)|(?<![\p{L}\p{N}])'[^']*(?:'|$)"#, in: command, with: " ")
            if let body = range(#"\b(?:saying|that says|with (?:the )?(?:text|body|message))\b|\b(?:body|subject)\s*:"#, in: command) {
                command = String(command[..<body.lowerBound])
            }

            let patterns = targetPatterns(devices, phoneName: phoneName, deviceAliasesByID: deviceAliasesByID)
            // Email/message bodies are data even when they contain imperative
            // sentences or unquoted device destinations.
            let initial = actionText(command, patterns: patterns)
            if [.email, .messaging].contains(classify(initial)) {
                if let initialRange = command.range(of: initial),
                   let body = range(#"\b(?:about|that|which says|with (?:the )?subject|with (?:the )?body)\b|:\s"#, in: initial) {
                    let offset = initial.distance(from: initial.startIndex, to: body.lowerBound)
                    command = String(command[..<command.index(initialRange.lowerBound, offsetBy: offset)])
                }
                if let body = range(#"^\s*(?:please\s+)?(?:email|e-mail|message|text|tell)\s+\S+(?:\s+\S+)?\s+to\s+"#, in: command) {
                    command = String(command[..<body.upperBound])
                }
            }

            let clauses = replacing(#"([,;])\s*|\b(?:but|instead|and then|then|and)\b|(?=\bnot\s+(?:on|using|via|from)\b)"#, in: command, with: "$1\n")
                .components(separatedBy: "\n").filter { !$0.trimmingCharacters(in: .whitespaces).isEmpty }
            var positiveTargets: [Target] = []
            var negativeTargets: [Target] = []
            var actions: [TaskRouteAction] = []
            var hasPositiveRequest = false
            for clause in clauses {
                let negative = range(#"^\s*(?:please\s+)?(?:do not|don't|dont|never|not|avoid|without)\b"#, in: clause) != nil
                let found = explicitTargets(clause, patterns: patterns)
                if negative {
                    negativeTargets.append(contentsOf: found)
                    continue
                }
                hasPositiveRequest = true
                positiveTargets.append(contentsOf: found)
                let content = actionText(clause, patterns: patterns)
                let action = classify(content)
                if action != .general { actions.append(action) }
            }
            guard hasPositiveRequest, !command.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
                throw TaskRouteError.clarification("What would you like the computer to do?")
            }
            let distinctActions = Set(actions)
            guard distinctActions.count <= 1 else {
                throw TaskRouteError.clarification("Please give one task at a time so I can choose the right computer.")
            }
            // Two names/families may identify the same device ("my Mac, Atlas").
            // Contradictory positive/negative targets need an explicit correction.
            if positiveTargets.contains(where: { negativeTargets.contains($0) }) {
                throw TaskRouteError.clarification("Which computer should I use? Your request includes conflicting targets.")
            }
            let named = positiveTargets.compactMap { target -> (String, String)? in
                if case let .named(id, name) = target { return (id, name) }
                return nil
            }
            if named.contains(where: { item in named.contains { $0.0 != item.0 && $0.1.caseInsensitiveCompare(item.1) == .orderedSame } }) {
                throw TaskRouteError.clarification("More than one computer has that name. Use its unique device name or ID.")
            }
            action = actions.first ?? .general
            targets = positiveTargets
            exclusions = negativeTargets
            unsupportedPhoneAction = range(#"\b(?:unlock|restart|reboot|erase|factory reset)\b|\b(?:camera|microphone|face\s?id)\b|\b(?:take|record)\s+(?:(?:a|the)\s+)?(?:photo|picture|video|audio)\b"#, in: command) != nil
        }
    }

    private struct TargetPattern {
        let target: Target
        let pattern: String
    }

    private static func targetPatterns(_ devices: [CoordinatorDevice], phoneName: String?, deviceAliasesByID: [String: String]) -> [TargetPattern] {
        let families: [(Target, String)] = [
            (.android, #"android(?:\s+phone)?"#),
            (.phone, #"(?:iphone(?:\s+mirroring|\s+\d+(?:\s+pro)?(?:\s+max)?)?|phone)"#),
            (.tablet, #"ipad(?:\s+(?:pro|air|mini))?(?:\s+\d+)?"#),
            (.quest, #"(?:(?:meta|oculus)\s+)?quest(?:\s+[23]s?)?(?:\s+headset)?"#),
            (.windows, #"windows(?:\s+\d+)?(?:\s+(?:pc|computer|laptop|desktop|machine))?"#),
            (.linux, #"linux(?:\s+(?:pc|computer|laptop|desktop|machine))?"#),
            (.mac, #"(?:macbook(?:\s+(?:pro|air))?|mac(?:os)?)(?:\s+(?:computer|laptop|desktop|machine))?"#),
            (.pc, #"pc"#)
        ]
        var result = families.map { TargetPattern(target: $0.0, pattern: $0.1) }
        let selectedPhoneNames = phoneName.map { [$0, $0.replacingOccurrences(of: "iphone", with: "phone", options: .caseInsensitive)] } ?? []
        for name in selectedPhoneNames {
            let normalized = name.lowercased().replacingOccurrences(of: "’", with: "'")
            result.append(TargetPattern(target: .phone, pattern: NSRegularExpression.escapedPattern(for: normalized)))
        }
        for device in devices {
            for name in [device.name, device.hostname ?? "", device.id, deviceAliasesByID[device.id] ?? ""] {
                let normalized = name.lowercased().replacingOccurrences(of: "’", with: "'").trimmingCharacters(in: .whitespacesAndNewlines)
                guard !normalized.isEmpty,
                      !families.contains(where: { range("^(?:" + $0.1 + ")$", in: normalized) != nil }) else { continue }
                result.append(TargetPattern(target: .named(id: device.id, name: displayName(device)),
                                            pattern: NSRegularExpression.escapedPattern(for: normalized)))
            }
        }
        return result
    }

    private static let polite = #"(?:(?:please|can you|could you|would you|will you|i want you to|i'd like you to)\s+)*"#
    private static let determiner = #"(?:(?:my|the|this|that|a|an|our)\s+)?"#

    private static func explicitTargets(_ text: String, patterns: [TargetPattern]) -> [Target] {
        var matches: [(Target, NSRange)] = []
        for entry in patterns {
            let device = determiner + "(?:" + entry.pattern + #")(?![\p{L}\p{N}_-])"#
            let expressions = [
                #"\b(?:on|onto|using|via|through|from)\s+"# + device,
                #"\b(?:use|ask|control|unlock|restart|reboot|switch to|connect to|cast to|send (?:this|it) to)\s+"# + device,
                "^\\s*" + polite + device + #"(?:\s*[:,]|\s+(?:open|show|run|start|launch|take|play|search|find|email|text)\b)"#,
                "^\\s*" + polite + #"open\s+"# + device + #"\s*[.!?]*$"#,
                #"\b(?:send|write|draft|compose|read|check|open)\s+(?:(?:a|the|my)\s+)?"# + device + #"\s+(?:messages?|texts?|e-?mail)\b"#,
                // Filesystem grammar is intentionally narrow. A computer name
                // following a file/folder operation identifies execution;
                // topical "Windows tutorials" or quoted text does not.
                #"\b(?:from|in|inside)\s+(?:the|my)\s+(?:downloads?|documents?|desktop)(?:\s+(?:folder|directory))?\s+of\s+"# + device,
                #"^\s*"# + polite + #"(?:open|show|list|search)\s+(?:(?:the|my)\s+)?"# + device + #"\s*'?s?\s+(?:downloads?|documents?|desktop)\s+(?:folder|directory)\b"#,
                #"\b(?:find|search|locate)\s+"# + device + #"\s+(?:computer\s+)?(?:for|to\s+find)\b"#,
                #"^\s*(?:find|locate|open|read|play)\s+(?:(?!\b(?:about|information|tutorials?|guides?|reviews?)\b)[\p{L}\p{N}._-]+\s+){0,8}(?:file|folder|directory)(?:\s+(?!\b(?:about|information|tutorials?|guides?|reviews?)\b)[\p{L}\p{N}._-]+){0,8}\s+(?:in|inside|from)\s+"# + device,
                #"^\s*search\s+for\s+(?:the|my)\s+(?:(?!\b(?:about|information|tutorials?|guides?|reviews?)\b)[\p{L}\p{N}._-]+\s+){0,8}(?:file|folder|directory)(?:\s+(?!\b(?:about|information|tutorials?|guides?|reviews?)\b)[\p{L}\p{N}._-]+){0,8}\s+(?:in|inside|from)\s+"# + device,
                #"^\s*(?:not|avoid|without)\s+"# + device
            ]
            for expression in expressions {
                guard let regex = try? NSRegularExpression(pattern: expression, options: .caseInsensitive) else { continue }
                for match in regex.matches(in: text, range: NSRange(text.startIndex..., in: text)) {
                    // "information on iPhone" is a topic, not an execution target.
                    let before = (text as NSString).substring(to: match.range.location)
                    if range(#"\b(?:information|info|reviews?|report|essay|article|details|thoughts|advice|tutorial|guide)\s*$"#, in: before) != nil { continue }
                    matches.append((entry.target, match.range))
                }
            }
        }
        // Prefer a complete registered name over a family suffix inside it.
        let longest = matches.filter { candidate in
            !matches.contains { other in
                other.1.length > candidate.1.length && NSIntersectionRange(other.1, candidate.1).length == candidate.1.length
            }
        }
        var result = longest.reduce(into: [Target]()) { if !$0.contains($1.0) { $0.append($1.0) } }
        // A possessive named computer must not disappear into default routing
        // simply because it is absent from the registered inventory.
        let ownedDevice = #"(?:[\p{L}\p{N}_-]+\s+){0,2}[\p{L}\p{N}_-]+'s\s+(?:mac(?:book)?|windows(?:\s+pc)?|linux(?:\s+pc)?|pc|computer|laptop|iphone|phone|android)\b"#
        let namedDestination = #"\b(?:on|onto|using|via|through|from|use|ask|control|open|unlock|restart|reboot)\s+"# + ownedDevice +
            "|^\\s*" + polite + ownedDevice + #"(?:\s*[:,]|\s+(?:open|show|run|start|launch|take|play|search|find|email|text)\b)"# +
            #"|\b(?:from|in|inside)\s+(?:the|my)\s+(?:downloads?|documents?|desktop)(?:\s+(?:folder|directory))?\s+of\s+"# + ownedDevice +
            #"|\b(?:find|search|locate)\s+"# + ownedDevice + #"\s+(?:for|to\s+find)\b"#
        if let regex = try? NSRegularExpression(pattern: namedDestination, options: .caseInsensitive) {
            for match in regex.matches(in: text, range: NSRange(text.startIndex..., in: text)) {
                if !longest.contains(where: { NSIntersectionRange($0.1, match.range).length > 0 }) {
                    result.append(.unregistered((text as NSString).substring(with: match.range)))
                }
            }
        }
        return result
    }

    private static func actionText(_ text: String, patterns: [TargetPattern]) -> String {
        var value = replacing("^\\s*" + polite, in: text, with: "")
        for entry in patterns {
            let device = determiner + "(?:" + entry.pattern + #")(?![\p{L}\p{N}_-])"#
            value = replacing(#"^(send|write|draft|compose|read|check|open)\s+(?:(?:a|the|my)\s+)?"# + device + #"\s+(messages?|texts?|e-?mail)\b"#, in: value, with: "$1 $2")
            value = replacing("^" + device + #"\s*[:,]\s*"#, in: value, with: "")
            value = replacing("^" + device + #"\s+(?=(?:open|show|run|start|launch|take|play|search|find|email|text)\b)"#, in: value, with: "")
            value = replacing(#"^(?:on|using|via)\s+"# + device + #"\s*[, :]\s*"#, in: value, with: "")
            value = replacing(#"^(?:use|ask)\s+"# + device + #"\s+to\s+"#, in: value, with: "")
        }
        return replacing("^\\s*" + polite, in: value, with: "")
    }

    private static func classify(_ text: String) -> TaskRouteAction {
        // A leading possessive iPhone search-bar instruction is browser work.
        // This is deliberately anchored so a recipient message merely quoting
        // the phrase keeps its normal messaging classification.
        if range(#"^\s*(?:on|using)\s+(?:my|the)\s+(?:iphone|phone)'?s\s+search\s+bar\b"#, in: text) != nil {
            return .browser
        }
        // “Tell me whether …” reports the result of the preceding action; it
        // is not a command to send a message to somebody.
        if range(#"^\s*tell\s+me\s+(?:whether|if)\b"#, in: text) != nil { return .general }
        if range(#"^(?:call\s+(?!(?:a |the )?(?:function|method|api|endpoint)\b)|dial\b|(?:make|place|start)\s+(?:(?:a|the)\s+)?(?:phone|facetime|voice|video)?\s*call\b|facetime\b)"#, in: text) != nil { return .phoneCall }
        if range(#"^(?:e-?mail\b|(?:send|write|draft|compose|read|check|open)\s+(?:(?:a|an|the|my)\s+)?(?:e-?mail|inbox|mail)\b|send\s+.+?\s+an?\s+e-?mail\b|(?:reply|respond)\s+to\b)"#, in: text) != nil { return .email }
        if range(#"^(?:text\b|message\b|tell\b|(?:send|write|draft|compose|read|check|open)\s+(?:(?:a|the|my)\s+)?(?:text|message|messages|imessage|whatsapp|slack)\b|send\s+.+?\s+(?:a\s+)?(?:text|message)\b)"#, in: text) != nil { return .messaging }
        if range(#"^(?:(?:find|search|locate|open|read|edit|create|write|save|move|rename|delete|list|show|summarize|organize)\s+.*\b(?:file|files|folder|folders|directory|directories|document|documents|pdf|downloads|desktop folder|repository|repo|codebase)\b|(?:run|execute)\s+(?:the\s+)?(?:tests|script|build)\b)"#, in: text) != nil { return .files }
        if range(#"^(?:search\b|google\b|browse\b|look\s+up\b|(?:open|launch|start|use)\s+(?:(?:a|the|my)\s+)?(?:safari|chrome|firefox|edge|browser|website|web\s+page|new\s+tab)\b|(?:go|navigate)\s+to\b|(?:open|visit)\s+(?:https?://|www\.|\S+\.(?:com|org|net|edu|io|ca)\b))"#, in: text) != nil { return .browser }
        return .general
    }

    private static func names(_ devices: [CoordinatorDevice]) -> String {
        let sorted = devices.sorted { $0.id < $1.id }
        return sorted.map { device in
            let name = displayName(device)
            return devices.filter { displayName($0) == name }.count > 1 ? "\(name) (\(device.id))" : name
        }.joined(separator: ", ")
    }

    private static func displayName(_ device: CoordinatorDevice) -> String {
        let name = device.name.trimmingCharacters(in: .whitespacesAndNewlines)
        return name.isEmpty ? device.id : name
    }

    private static func validAlias(_ value: String) -> Bool {
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        return (1...80).contains(trimmed.count) && trimmed.unicodeScalars.allSatisfy { !CharacterSet.controlCharacters.contains($0) }
    }

    private static func range(_ pattern: String, in value: String) -> Range<String.Index>? {
        value.range(of: pattern, options: [.regularExpression, .caseInsensitive])
    }

    private static func replacing(_ pattern: String, in value: String, with replacement: String) -> String {
        value.replacingOccurrences(of: pattern, with: replacement, options: [.regularExpression, .caseInsensitive])
    }
}
