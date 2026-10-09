import Foundation

let oldShape = #"{"id":"00000000-0000-4000-8000-000000000001","status":"ready","source":"text","version":1,"transcript":"Email Alex","draft":{"recipientName":"Alex","recipientEmail":null,"subject":"Prototype","body":"I can help tomorrow."},"recipientSource":"needs_address","sender":"sender@example.com","send":{"status":"not_sent","message":"Draft only."},"savedToMailbox":false}"#
let decoder = JSONDecoder()
let oldJob = try decoder.decode(AssistantJob.self, from: Data(oldShape.utf8))
var additive = try JSONSerialization.jsonObject(with: Data(oldShape.utf8)) as! [String: Any]
additive["clarification"] = "What is Alex's email address?"
additive["contactProposal"] = ["name": "Alex", "email": "alex@example.com"]
let newJob = try decoder.decode(AssistantJob.self, from: JSONSerialization.data(withJSONObject: additive))
precondition(oldJob.id == newJob.id && oldJob.version == newJob.version)
precondition(newJob.status == "ready" && newJob.source == "text")
precondition(newJob.draft == oldJob.draft && newJob.send.status == "not_sent")
precondition(!newJob.savedToMailbox)
additive["draft"] = NSNull()
additive.removeValue(forKey: "contactProposal")
let questionOnly = try decoder.decode(AssistantJob.self, from: JSONSerialization.data(withJSONObject: additive))
precondition(questionOnly.status == "ready" && questionOnly.draft == nil && questionOnly.send.status == "not_sent")
print("C01 old Job fields, C02 additive clarification/contactProposal, C03 ready question without a draft decode. No voice-feature or visible UI support is inferred.")
