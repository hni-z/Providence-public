use framework "Foundation"
use scripting additions

on run arguments
    set messageData to current application's NSData's dataWithContentsOfFile:(item 1 of arguments)
    if messageData is missing value then error "Missing message payload"
    set messageObject to current application's NSJSONSerialization's JSONObjectWithData:messageData options:0 |error|:(missing value)
    if messageObject is missing value then error "Invalid message payload"
    set fromAddress to (messageObject's objectForKey:"sender") as text
    set toAddress to (messageObject's objectForKey:"recipientEmail") as text
    set subjectText to (messageObject's objectForKey:"subject") as text
    set bodyText to (messageObject's objectForKey:"body") as text
    tell application "Mail"
        set senderFound to false
        repeat with configuredAccount in accounts
            if enabled of configuredAccount then
                if fromAddress is in (email addresses of configuredAccount) then set senderFound to true
            end if
        end repeat
        if not senderFound then error "Sender account unavailable"
        set outgoing to make new outgoing message with properties {sender:fromAddress, subject:subjectText, content:bodyText & return, visible:false}
        set resolvedSender to extract address from (sender of outgoing)
        if resolvedSender is not fromAddress then
            delete outgoing
            error "Mail selected a different sender; nothing sent"
        end if
        tell outgoing
            make new to recipient at end of to recipients with properties {address:toAddress}
            set outgoingID to id
        end tell
        set accepted to send outgoing
        if accepted is not true then error "Mail did not confirm submission"
        -- This is a local Mail ID, NOT a Gmail message ID or delivery receipt.
        return "submitted:" & (outgoingID as text)
    end tell
end run
