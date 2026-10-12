Add-Type -AssemblyName System.IO.Compression.FileSystem
$src = '/tmp/brief.docx'
$dst = 'prompt_extract.txt'
$z = [System.IO.Compression.ZipFile]::OpenRead($src)
$e = $z.Entries | Where-Object { $_.FullName -eq 'word/document.xml' }
$sr = New-Object System.IO.StreamReader($e.Open())
$t = $sr.ReadToEnd()
$sr.Close()
$z.Dispose()
$t = $t -replace '</w:p>', "`n"
$t = $t -replace '<w:tab[^>]*/>', "`t"
$t = $t -replace '<[^>]+>', ''
$t = [System.Net.WebUtility]::HtmlDecode($t)
[System.IO.File]::WriteAllText($dst, $t, (New-Object System.Text.UTF8Encoding($false)))
Write-Output "written $dst"
