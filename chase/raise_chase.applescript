-- Brings the Chrome window whose active tab is the superchallenge race page to the front (keeps the chase tab visible).
tell application "Google Chrome"
	repeat with w in windows
		if (URL of active tab of w) contains "superchallenge.io" then
			set index of w to 1
			activate
			return "raised: " & (title of active tab of w)
		end if
	end repeat
	return "chase window not found"
end tell
