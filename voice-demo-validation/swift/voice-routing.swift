import Foundation

@main
struct IndependentVoiceRouting {
    static func main() throws {
        let emailRequests = [
            "Email Alex at alex at example dot com saying I can help tomorrow",
            "Please send an email to first underscore last plus demo at example dot com saying hi",
            "Respond to Alex saying I can help tomorrow",
            "Reply to the latest email from Alex in the same thread saying hi",
            "Draft an email to Jordan saying open Safari",
        ]
        let macRequests = [
            "On my Mac, open https://example.com in Safari and tell me the page title.",
            "Open the email validation tests on my Mac",
            "Find the text respond to Alex in the project",
            "Show alex@example.com in the browser",
        ]
        for input in emailRequests { precondition(VoiceRoute.recognize(input) == .email, input) }
        for input in macRequests { precondition(VoiceRoute.recognize(input) == .mac, input) }
        for canceledOrEmpty in ["", " ", "\n"] {
            do { _ = try PreparedVoiceRequest(text: canceledOrEmpty); preconditionFailure("Empty dictation became a request") }
            catch { }
        }
        let pending = try PreparedVoiceRequest(text: emailRequests[0])
        let restored = try JSONDecoder().decode(PreparedVoiceRequest.self, from: JSONEncoder().encode(pending))
        precondition(restored == pending)
        print("W01/W02: nine real-router transcript cases pass; empty values rejected; saved voice request value roundtrips.")
        print("No claim about native cancel callbacks, actual app reopen, automatic Done dispatch, or real network calls.")
    }
}
