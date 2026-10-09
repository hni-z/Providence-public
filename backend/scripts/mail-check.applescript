on run arguments
    set requestedSender to item 1 of arguments
    tell application "Mail"
        repeat with configuredAccount in accounts
            if enabled of configuredAccount then
                if requestedSender is in (email addresses of configuredAccount) then return "ready"
            end if
        end repeat
    end tell
    error "No enabled Mail account matches the configured sender."
end run
