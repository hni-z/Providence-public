import Foundation

let ready = #"{"id":"3a7d672f-61f2-4254-b716-e0c5af36aeb8","status":"ready","source":"audio","version":1,"transcript":"Email Alex","draft":{"recipientName":"Alex","recipientEmail":null,"subject":"Prototype","body":"Can you test it?"},"recipientSource":"needs_address","sender":"demo@example.com","send":{"status":"not_sent","message":"Draft only."},"savedToMailbox":false}"#
let job = try JSONDecoder().decode(AssistantJob.self, from: Data(ready.utf8))
precondition(job.draft?.recipientEmail == nil && job.draft?.body == "Can you test it?")
precondition(job.version == 1 && job.send.status == "not_sent" && !job.savedToMailbox)
let pending = #"{"id":"3a7d672f-61f2-4254-b716-e0c5af36aeb8","status":"transcribing","source":"audio","version":1,"sender":null,"send":{"status":"not_sent","message":"Draft only."},"savedToMailbox":false}"#
let pendingJob = try JSONDecoder().decode(AssistantJob.self, from: Data(pending.utf8))
precondition(pendingJob.draft == nil)
let approval = #"{"token":"abc","version":2,"sender":"demo@example.com","draft":{"recipientName":null,"recipientEmail":"alex@example.com","subject":"Test","body":"Hello"}}"#
let sendApproval = try JSONDecoder().decode(SendApproval.self, from: Data(approval.utf8))
precondition(sendApproval.version == 2)
let recipientEdit = try RecipientUpdate(job: job, address: "person at example dot com")
precondition(recipientEdit.version == job.version)
precondition(recipientEdit.draft.recipientEmail == "person@example.com")
precondition(recipientEdit.draft.subject == job.draft?.subject)
precondition(recipientEdit.draft.body == job.draft?.body)
precondition(recipientEdit.draft.recipientName == job.draft?.recipientName)
let payload = try JSONSerialization.jsonObject(with: JSONEncoder().encode(recipientEdit)) as! [String: Any]
precondition(Set(payload.keys) == Set(["version", "draft"]))
precondition((payload["draft"] as? [String: Any])?["recipientEmail"] as? String == "person@example.com")
for (input, expected) in [(" first.last+demo@example.com ", "first.last+demo@example.com"),
                          ("first dot last plus demo at example dot co dot uk", "first.last+demo@example.co.uk"),
                          ("first @ example . com", "first@example.com")] {
    let normalized = try RecipientUpdate(job: job, address: input)
    precondition(normalized.draft.recipientEmail == expected)
}
for invalid in ["Yusuf Abdusayed", "first last at example dot com", "person@example.com and other@example.com",
                "person@example.com\nBcc: other@example.com", "person at example", "", String(repeating: "a", count: 250) + "@example.com"] {
    do { _ = try RecipientUpdate(job: job, address: invalid); preconditionFailure("Invalid recipient accepted") }
    catch { }
}
do { _ = try RecipientUpdate(job: pendingJob, address: "person@example.com"); preconditionFailure("Processing job was editable") }
catch { }
for status in ["submitting", "submitted", "uncertain"] {
    let submitted = ready.replacingOccurrences(of: "not_sent", with: status)
    let submittedJob = try JSONDecoder().decode(AssistantJob.self, from: Data(submitted.utf8))
    do { _ = try RecipientUpdate(job: submittedJob, address: "person@example.com"); preconditionFailure("Dispatched job was editable") }
    catch { }
}
print("Swift job/approval decoding and recipient-edit contracts passed.")
