' Starts the bridge daemon with no visible window.
' Copy to: shell:startup  (Win+R -> shell:startup)
Set sh = CreateObject("WScript.Shell")
target = sh.ExpandEnvironmentStrings("%USERPROFILE%") & "\.claude\hooks\bridge.mjs"
sh.Run "node """ & target & """", 0, False
