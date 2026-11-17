param([Parameter(Mandatory)][string]$Executable)
& $Executable app-server --stdio
exit $LASTEXITCODE
