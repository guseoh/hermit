param([Parameter(Mandatory)][string]$Executable)
# App Server 프로토콜은 UTF-8 JSON이다. 표준 입출력 인코딩을 UTF-8로 고정한다.
$utf8 = New-Object System.Text.UTF8Encoding $false
[Console]::InputEncoding = $utf8
[Console]::OutputEncoding = $utf8
$OutputEncoding = $utf8
& $Executable app-server --stdio
exit $LASTEXITCODE
