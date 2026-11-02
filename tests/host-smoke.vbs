Option Explicit
On Error Resume Next
Dim illustrator, result
Set illustrator = GetObject(, "Illustrator.Application")
If Err.Number <> 0 Then
  WScript.Echo "ILLUSTRATOR_COM_UNAVAILABLE: " & Err.Description
  WScript.Quit 2
End If
If WScript.Arguments.Count <> 1 Then
  WScript.Echo "Usage: cscript //nologo host-smoke.vbs absolute-path-to-host-smoke.jsx"
  WScript.Quit 2
End If
Err.Clear
result = illustrator.DoJavaScriptFile(WScript.Arguments(0))
If Err.Number <> 0 Then
  WScript.Echo "ILLUSTRATOR_COM_ERROR: " & Err.Description
  WScript.Quit 1
End If
WScript.Echo result
