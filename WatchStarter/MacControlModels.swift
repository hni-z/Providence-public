import Foundation
import WatchCoordinatorAdapter

struct ProvidenceCoordinatorConfiguration: Decodable {
    let baseURL: URL
    let deviceID: String
    let chatID: String
    var transcriptionDeviceID: String
    var iphoneMirroringTarget: IPhoneMirroringTarget? = nil
    var preferredChatIDsByDevice: [String: String] = [:]
    var deviceAliasesByID: [String: String] = [:]
    var workflow: CoordinatorWorkflowManifest? = nil

    enum CodingKeys: String, CodingKey {
        case baseURL
        case deviceID = "deviceId"
        case chatID = "chatId"
        case transcriptionDeviceID = "transcriptionDeviceId"
        case iphoneMirroringTarget
        case preferredChatIDsByDevice
        case deviceAliasesByID
        case workflow
    }

    init(baseURL: URL, deviceID: String, chatID: String,
         iphoneMirroringTarget: IPhoneMirroringTarget? = nil,
         preferredChatIDsByDevice: [String: String] = [:],
         deviceAliasesByID: [String: String] = [:],
         transcriptionDeviceID: String? = nil, workflow: CoordinatorWorkflowManifest? = nil) {
        self.baseURL = baseURL
        self.deviceID = deviceID
        self.chatID = chatID
        self.transcriptionDeviceID = transcriptionDeviceID ?? deviceID
        self.iphoneMirroringTarget = iphoneMirroringTarget
        self.preferredChatIDsByDevice = preferredChatIDsByDevice
        self.deviceAliasesByID = deviceAliasesByID
        self.workflow = workflow
    }

    init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        self.init(
            baseURL: try values.decode(URL.self, forKey: .baseURL),
            deviceID: try values.decode(String.self, forKey: .deviceID),
            chatID: try values.decode(String.self, forKey: .chatID),
            iphoneMirroringTarget: try values.decodeIfPresent(IPhoneMirroringTarget.self, forKey: .iphoneMirroringTarget),
            preferredChatIDsByDevice: try values.decodeIfPresent([String: String].self, forKey: .preferredChatIDsByDevice) ?? [:],
            deviceAliasesByID: try values.decodeIfPresent([String: String].self, forKey: .deviceAliasesByID) ?? [:],
            transcriptionDeviceID: try values.decodeIfPresent(String.self, forKey: .transcriptionDeviceID),
            workflow: try values.decodeIfPresent(CoordinatorWorkflowManifest.self, forKey: .workflow)
        )
    }

    static func load() throws -> ProvidenceCoordinatorConfiguration {
        guard let url = Bundle.main.url(forResource: "ProvidenceCoordinatorConfig", withExtension: "json") else {
            // A public build discovers the user's devices after account pairing.
            return ProvidenceCoordinatorConfiguration(
                baseURL: URL(string: "https://providence.hani.so")!,
                deviceID: "coordinator", chatID: "master", transcriptionDeviceID: "providence-voice")
        }
        return try decodeAndValidate(Data(contentsOf: url))
    }

    static func decodeAndValidate(_ data: Data) throws -> ProvidenceCoordinatorConfiguration {
        let configuration = try JSONDecoder().decode(Self.self, from: data)
        guard configuration.baseURL.scheme?.lowercased() == "https",
              configuration.baseURL.host?.lowercased() == "providence.hani.so",
              configuration.baseURL.port == nil,
              configuration.baseURL.user == nil,
              configuration.baseURL.password == nil,
              configuration.baseURL.path == "/" || configuration.baseURL.path.isEmpty,
              configuration.baseURL.query == nil,
              configuration.baseURL.fragment == nil,
              Self.validID(configuration.deviceID), Self.validID(configuration.chatID), Self.validID(configuration.transcriptionDeviceID),
              configuration.iphoneMirroringTarget.map(\.isValid) ?? true,
              configuration.preferredChatIDsByDevice.allSatisfy({ Self.validID($0.key) && Self.validID($0.value) }),
              configuration.deviceAliasesByID.allSatisfy({ Self.validID($0.key) && Self.validAlias($0.value) }),
              configuration.workflow.map({ $0.version == 1 }) ?? true,
              Set(configuration.deviceAliasesByID.values.map { $0.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() }).count == configuration.deviceAliasesByID.count else {
            throw MacControlError.message("Mac routing configuration must use the canonical HTTPS coordinator and exact device and chat IDs.")
        }
        return configuration
    }

    private static func validID(_ value: String) -> Bool {
        value.range(of: "^[A-Za-z0-9_-]{1,200}$", options: .regularExpression) != nil
    }

    private static func validAlias(_ value: String) -> Bool {
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        return (1...80).contains(trimmed.count) && trimmed.unicodeScalars.allSatisfy { !CharacterSet.controlCharacters.contains($0) }
    }
}

struct WatchTargetOption: Identifiable, Equatable, Sendable {
    let id: String
    let deviceID: String
    let chatID: String
    let deviceName: String
    let chatName: String
    let online: Bool
}

enum MacControlContracts {
    static func workStatus(_ task: CoordinatorTask) -> TaskStatus {
        if let workStatus = task.workStatus { return workStatus }
        if task.status == .completed, !(task.childTaskIDs ?? []).isEmpty { return .running }
        return task.status
    }

    static let basicApprovalMethods: Set<String> = [
        "item/commandExecution/requestApproval",
        "item/fileChange/requestApproval"
    ]

    struct DecisionQuestion: Equatable {
        let id: String
        let question: String
        let options: [String]
    }

    static func decisionQuestion(_ approval: CoordinatorApproval) -> DecisionQuestion? {
        guard approval.method == "item/tool/requestUserInput",
              case let .object(details) = approval.details,
              case let .array(questions)? = details["questions"], questions.count == 1,
              case let .object(question) = questions[0],
              case let .string(id)? = question["id"], !id.isEmpty,
              case let .string(text)? = question["question"], !text.isEmpty, text.count <= 2000,
              case let .array(options)? = question["options"], (2...4).contains(options.count) else { return nil }
        let labels = options.compactMap { option -> String? in
            guard case let .object(value) = option, case let .string(label)? = value["label"],
                  !label.isEmpty, label.count <= 200 else { return nil }
            return label
        }
        guard labels.count == options.count, Set(labels).count == labels.count else { return nil }
        return DecisionQuestion(id: id, question: text, options: labels)
    }

    static func isSupportedApproval(_ approval: CoordinatorApproval) -> Bool {
        isBasicApproval(approval) || decisionQuestion(approval) != nil
    }

    static func isBasicApproval(_ approval: CoordinatorApproval) -> Bool {
        basicApprovalMethods.contains(approval.method)
    }

    static func matchesDisplayedApproval(_ fresh: CoordinatorApproval, displayed: CoordinatorApproval, task: CoordinatorTask, configuration: ProvidenceCoordinatorConfiguration) -> Bool {
        task.status == .needsInput && task.chatID == configuration.chatID && task.deviceID == configuration.deviceID &&
        displayed.taskID == task.id && displayed.deviceID == configuration.deviceID && displayed.status == "pending" &&
        fresh.id == displayed.id && fresh.taskID == task.id && fresh.deviceID == configuration.deviceID && fresh.status == "pending" && fresh.method == displayed.method && fresh.details == displayed.details
    }
}

struct MacPreparedRequest: Codable, Equatable {
    let requestID: UUID
    let text: String
    let chatID: String
    let deviceID: String
    var transcriptionDeviceID: String? = nil
    var spokenText: String? = nil
    var iphoneMirroring: IPhoneMirroringRoute? = nil
    var coordinated: Bool? = nil
    var workflow: CoordinatorWorkflowManifest? = nil
}

enum WatchCoordinationIntent {
    static func isExplicit(_ text: String) -> Bool {
        text.trimmingCharacters(in: .whitespacesAndNewlines).range(
            of: #"^coordinate\s+across\s+(?:my|our|the)\s+(?:connected\s+)?computers\b"#,
            options: [.regularExpression, .caseInsensitive]) != nil
    }
}

enum WatchWorkflowIntent {
    static func isExplicit(_ text: String) -> Bool {
        text.trimmingCharacters(in: .whitespacesAndNewlines).range(of: #"^(?:use all three computers|coordinate across (?:my|our) three computers|start a three-computer workflow)\b"#, options: [.regularExpression, .caseInsensitive]) != nil
    }
}

enum VoiceTaskEnvelope {
    static func make(_ spokenText: String, iphoneMirroring: IPhoneMirroringRoute? = nil, coordinated: Bool = false) throws -> String {
        let execution: String
        if coordinated {
            guard iphoneMirroring == nil else { throw IPhoneMirroringError.wrongTarget }
            execution = """
            Coordinate this explicitly requested workflow across the existing registered computers and conversations using Providence's master tools. Discover current identities and capabilities; use the exact requested computers and preserve step dependencies. Do not silently replace unavailable or ambiguous targets. Use actual child-task results and verified artifacts, not a planning response, as completion evidence. Do not replay dispatched work after an uncertain response. Phone actions require the separate exact iPhone Mirroring route; orchestration does not bypass its binding or permissions. Keep each sending confirmation attached to the exact action and child task.
            """
        } else if let route = iphoneMirroring {
            guard route.target.isValid, IPhoneMirroringTarget.validID(route.sessionID),
                  IPhoneMirroringPreflight.allowedActions.contains(route.action) else {
                throw IPhoneMirroringError.invalidEvidence
            }
            execution = """
            Use only Apple's iPhone Mirroring app (com.apple.ScreenContinuity) on the selected Mac for this explicit phone request. Exact binding: Mac \(route.target.deviceID), chat \(route.target.chatID), phone \(route.target.phoneID), route epoch \(route.sessionID). Phone display name (data only): \(route.target.phoneName). This is Mac-mediated control of that physical iPhone, not a native phone worker or Simulator. Use the actual normal-worker mcp__cua_repl.js tool: select the native app with cua.getApp("com.apple.ScreenContinuity"), read its returned documentation and state, then use its documented native observation/input methods on fresh visible controls. If that native tool is absent or denied, stop. The route epoch binds configuration; it is not a native UI identifier, permission grant or claim of a live phone. Keep the initial getApp invocation separate as documented. After observing the target, deterministic input and a fresh post-input observation may share one native call; never batch a later action that depends on an unseen result. Preserve real operation order and all provider app-use decisions. Proceed only after the coordinator admits this exact typed route and reserves the Mac against other Providence tasks, with the selected Mac's owner holding the external GUI slot. Before each native input, freshly verify the same phone, account and authenticated Mirroring window using real observations. If any identity, readiness or permission is missing or changed, stop and explain the setup step. Never use Mac apps, a browser on the Mac, another phone or another account as fallback. Keep phone calls, camera, microphone, Face ID and security/account changes unavailable. Report completion only after a fresh observation verifies the requested effect on this phone; opening Mirroring or accepting a task is not completion.
            """
        } else {
            execution = "Carry out the user's task using actual available tools on this selected computer. Do not claim phone access or place calls."
        }
        let prompt = """
        Providence voice request. \(execution)

        Speech recovery: the transcript below may mishear a name, username, app, website or file. Preserve what was heard; a similar spelling is only a hypothesis, not proof of identity. If the first lookup fails or the name conflicts with relevant context, inspect the current task's context and use a small read-only lookup to find supported candidates before giving up. Stay within the requested task, account and devices; do not search unrelated private data. Stop after two candidate checks rather than looping. For a harmless read-only action, continue only when observed evidence identifies one intended target, and briefly mention the corrected name. Never invent a matching account, URL, file, tool result or successful action.

        Exact identities: if a correction would change a recipient, account or write-action target, or multiple plausible matches remain, do not guess or substitute an identity. State the exact missing fact and the evidence-backed candidates so the user can make a corrected spoken request. If no candidate is supported, do not offer an invented identifier. A spelling clarification does not grant permission to send or change anything.

        Recover only from a known, safe failure. Never repeat an uncertain action or create a replacement task/change its target to bypass a failure or unknown outcome. Act on clear, already-authorized requests without adding a separate Providence confirmation. Keep the specified sender, recipient, content and device. Applicable tool and platform permissions still apply: surface their actual requirements, never fabricate approval or weaken them, and report a concrete blocker when necessary. The optional Providence decision tool is unavailable; do not claim that a decision card exists or wait for an answer from it. If a critical missing fact cannot be recovered, explain what is missing instead of claiming completion.

        Spoken response: default to two short sentences and at most 50 words unless the user asks for more detail. Lead with the verified outcome and preserve important caveats or uncertainty. Use short human-readable labels for source links; never spell out URLs in prose. User request follows:
        \(spokenText)
        """
        guard prompt.utf16.count <= 8000 else { throw MacControlError.message("Please say a shorter request.") }
        return prompt
    }
}

/// Public, opaque routing identities only. Never store Apple Account identifiers,
/// serial numbers, credentials, or screen contents in this binding.
struct IPhoneMirroringTarget: Codable, Equatable, Sendable {
    let deviceID: String
    let chatID: String
    let phoneID: String
    let phoneName: String

    enum CodingKeys: String, CodingKey {
        case deviceID = "deviceId", chatID = "chatId", phoneID = "phoneId", phoneName
    }

    static func validID(_ value: String) -> Bool {
        value.range(of: "^[A-Za-z0-9_-]{1,200}$", options: .regularExpression) != nil
    }

    var isValid: Bool {
        [deviceID, chatID, phoneID].allSatisfy(Self.validID) &&
        (1...80).contains(phoneName.count) && !phoneName.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty &&
        phoneName.unicodeScalars.allSatisfy { !CharacterSet.controlCharacters.contains($0) }
    }
}

/// sessionID is a coordinator-issued readiness lease, not an ID exposed by CUA.
/// Persist along with the unchanged request UUID/text. A dismissed error must
/// never remove this binding or promote a pending/unknown send to a new request.
struct IPhoneMirroringRoute: Codable, Equatable, Sendable {
    let target: IPhoneMirroringTarget
    let sessionID: String
    let action: String
}

enum IPhoneMirroringError: String, LocalizedError, Codable, Equatable, Sendable {
    case notConfigured, appMissing, phoneUnavailable, authenticationRequired
    case wrongTarget, controlUnavailable, acceptanceRequired, invalidEvidence
    case staleEvidence, unsupportedAction, macUnavailable, chatUnavailable, sessionChanged

    var errorDescription: String? {
        switch self {
        case .notConfigured: return "iPhone control needs setup on the selected Mac."
        case .appMissing: return "iPhone Mirroring is not available on the selected Mac."
        case .phoneUnavailable: return "The selected iPhone is not ready for Mirroring."
        case .authenticationRequired: return "The owner needs to finish Mirroring sign-in on the selected Mac."
        case .wrongTarget: return "The selected Mac or iPhone changed."
        case .controlUnavailable: return "Providence cannot control the mirrored iPhone yet."
        case .acceptanceRequired: return "iPhone control still needs a harmless test on the selected Mac."
        case .invalidEvidence: return "The iPhone readiness check could not be verified."
        case .staleEvidence: return "The iPhone connection needs a fresh check."
        case .unsupportedAction: return "This action is not available through iPhone Mirroring."
        case .macUnavailable: return "The selected Mac is offline or unavailable."
        case .chatUnavailable: return "The selected Mac conversation is unavailable."
        case .sessionChanged: return "The iPhone route changed. Check this request before continuing."
        }
    }

    var recoverySuggestion: String? {
        switch self {
        case .notConfigured: return "Set up the exact selected Mac, conversation and iPhone in Providence, then verify Mirroring on that Mac."
        case .appMissing: return "Check Apple's device requirements and open iPhone Mirroring on the selected Mac."
        case .phoneUnavailable: return "Keep the powered iPhone near the selected Mac with Wi-Fi and Bluetooth on. Its owner can complete any unlock prompt, then leave the phone locked."
        case .authenticationRequired: return "The owner must handle the Apple passcode or authentication prompt. Leave the existing accounts and security settings unchanged."
        case .wrongTarget: return "Restore the selected Mac and iPhone. Do not switch devices or accounts to continue this request."
        case .controlUnavailable, .acceptanceRequired: return "Run the harmless Mirroring check through the actual Providence worker. App presence and desktop access alone do not prove phone control."
        case .invalidEvidence, .staleEvidence: return "Refresh the same Mac's readiness check. Keep any pending request and its original identity."
        case .unsupportedAction: return "Use a supported phone action after setup. Calls, camera, microphone and security changes are unavailable."
        case .macUnavailable, .chatUnavailable: return "Restore the existing Mac connection and conversation. Do not create a replacement request."
        case .sessionChanged: return "Inspect the original task and phone for an effect. Keep the saved request ID; never resend an uncertain message as a new task."
        }
    }
}

/// Consumer of trusted route configuration or legacy effective observation.
/// Neither replaces actual worker preflight before phone input.
enum IPhoneMirroringPreflight {
    static let allowedActions: Set<String> = ["general", "browser", "messaging", "email"]

    static func validate(target: IPhoneMirroringTarget, devices: [CoordinatorDevice], chats: [CoordinatorChat],
                         action: String, now: Date = Date(), expectedSessionID: String? = nil) throws -> IPhoneMirroringRoute {
        guard target.isValid, Set(devices.map(\.id)).count == devices.count,
              Set(chats.map(\.id)).count == chats.count else { throw IPhoneMirroringError.invalidEvidence }
        guard let device = devices.first(where: { $0.id == target.deviceID }), device.online,
              ["darwin", "macos", "mac", "osx", "os x"].contains(device.platform?.lowercased() ?? "") else {
            throw IPhoneMirroringError.macUnavailable
        }
        guard chats.contains(where: { $0.id == target.chatID && $0.deviceID == target.deviceID && $0.online }) else {
            throw IPhoneMirroringError.chatUnavailable
        }
        guard case let .object(capabilities)? = device.capabilities else { throw IPhoneMirroringError.notConfigured }
        // Durable routing configuration intentionally has no TTL and makes no
        // claim that the phone is currently reachable or controllable. Its
        // epoch is an exact recovery binding; the normal worker must perform
        // a live preflight before every native input.
        if let binding = capabilities["iphoneMirroringBinding"] {
            return try validateBinding(binding, target: target, action: action, expectedSessionID: expectedSessionID)
        }
        guard let value = capabilities["iphoneMirroring"], value != .null else { throw IPhoneMirroringError.notConfigured }
        guard case let .object(evidence) = value,
              evidence["schemaVersion"] == .number(1),
              evidence["transport"] == .string("apple-iphone-mirroring"),
              evidence["appBundleId"] == .string("com.apple.ScreenContinuity"),
              case let .string(sessionID)? = evidence["sessionId"], IPhoneMirroringTarget.validID(sessionID) else {
            throw IPhoneMirroringError.invalidEvidence
        }
        for (key, expected) in [("deviceId", target.deviceID), ("chatId", target.chatID),
                                ("phoneId", target.phoneID), ("phoneName", target.phoneName)] {
            guard evidence[key] == .string(expected) else { throw IPhoneMirroringError.wrongTarget }
        }
        guard case let .number(observed)? = evidence["observedAt"],
              case let .number(expires)? = evidence["expiresAt"], observed.isFinite, expires.isFinite,
              observed <= now.timeIntervalSince1970 + 5, expires > now.timeIntervalSince1970,
              expires > observed, expires - observed <= 60, now.timeIntervalSince1970 - observed <= 60 else {
            throw IPhoneMirroringError.staleEvidence
        }
        let gates: [(String, IPhoneMirroringError)] = [
            ("configured", .notConfigured), ("appPresent", .appMissing), ("phoneReachable", .phoneUnavailable),
            ("authenticated", .authenticationRequired), ("identityVerified", .wrongTarget),
            ("controllable", .controlUnavailable), ("effectVerified", .acceptanceRequired), ("executable", .controlUnavailable)
        ]
        for (key, failure) in gates where evidence[key] != .bool(true) { throw failure }
        guard case let .array(actions)? = evidence["supportedActions"], !actions.isEmpty,
              actions.allSatisfy({ if case let .string(value) = $0 { return allowedActions.contains(value) }; return false }),
              allowedActions.contains(action), actions.contains(.string(action)) else { throw IPhoneMirroringError.unsupportedAction }
        if let expectedSessionID, expectedSessionID != sessionID { throw IPhoneMirroringError.sessionChanged }
        return IPhoneMirroringRoute(target: target, sessionID: sessionID, action: action)
    }

    private static func validateBinding(_ value: JSONValue, target: IPhoneMirroringTarget,
                                        action: String, expectedSessionID: String?) throws -> IPhoneMirroringRoute {
        guard case let .object(binding) = value,
              Set(binding.keys) == Set(["schemaVersion", "transport", "appBundleId", "status", "deviceId", "chatId", "phoneId", "phoneName", "bindingEpoch", "allowedActions", "requiresLivePreflight", "grantsPermission"]),
              binding["schemaVersion"] == .number(1),
              binding["transport"] == .string("apple-iphone-mirroring"),
              binding["appBundleId"] == .string("com.apple.ScreenContinuity"),
              binding["status"] == .string("configured"),
              binding["requiresLivePreflight"] == .bool(true), binding["grantsPermission"] == .bool(false),
              case let .string(epoch)? = binding["bindingEpoch"], IPhoneMirroringTarget.validID(epoch) else {
            throw IPhoneMirroringError.invalidEvidence
        }
        for (key, expected) in [("deviceId", target.deviceID), ("chatId", target.chatID),
                                ("phoneId", target.phoneID), ("phoneName", target.phoneName)] {
            guard binding[key] == .string(expected) else { throw IPhoneMirroringError.wrongTarget }
        }
        guard case let .array(actions)? = binding["allowedActions"], !actions.isEmpty,
              actions.count <= allowedActions.count else {
            throw IPhoneMirroringError.unsupportedAction
        }
        let actionValues = actions.compactMap { if case let .string(value) = $0 { return value }; return nil }
        guard actionValues.count == actions.count, Set(actionValues).count == actionValues.count,
              actionValues.allSatisfy(allowedActions.contains), allowedActions.contains(action), actionValues.contains(action) else {
            throw IPhoneMirroringError.unsupportedAction
        }
        if let expectedSessionID, expectedSessionID != epoch { throw IPhoneMirroringError.sessionChanged }
        return IPhoneMirroringRoute(target: target, sessionID: epoch, action: action)
    }

    static func revalidate(_ route: IPhoneMirroringRoute, devices: [CoordinatorDevice], chats: [CoordinatorChat],
                           now: Date = Date()) throws {
        _ = try validate(target: route.target, devices: devices, chats: chats, action: route.action,
                         now: now, expectedSessionID: route.sessionID)
    }
}

enum MacControlError: LocalizedError {
    case message(String)

    var errorDescription: String? {
        switch self { case let .message(value): return value }
    }
}
