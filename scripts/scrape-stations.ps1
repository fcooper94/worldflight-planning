# Scrape AFV Station Editor - page through all 15530 stations
# Make sure Station Editor is open on Stations tab, page size 100

Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes

$outputFile = "c:\dev\WorldFlight-Planning\data\afv_stations.csv"
"Name,Frequency" | Out-File $outputFile -Encoding UTF8

# Find window
$root = [System.Windows.Automation.AutomationElement]::RootElement
$window = $null
foreach ($w in $root.FindAll([System.Windows.Automation.TreeScope]::Children, [System.Windows.Automation.Condition]::TrueCondition)) {
    if ($w.Current.Name -like "*Station Editor*") { $window = $w; break }
}
if (-not $window) { Write-Host "Station Editor not found"; exit }
Write-Host "Found: $($window.Current.Name)"

# Find DataGrid
$gridCond = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::DataGrid)
$grid = $window.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $gridCond)
if (-not $grid) { Write-Host "Grid not found"; exit }

# Find Next button
$nextCond = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::NameProperty, "Next")
$nextBtn = $window.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $nextCond)

$rowCond = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::DataItem)
$totalRows = 0
$page = 1
$allData = @{}

function Read-VisibleRows {
    param($grid, $rowCond)

    # Get ScrollPattern
    $sp = $null
    try { $sp = $grid.GetCurrentPattern([System.Windows.Automation.ScrollPattern]::Pattern) } catch {}
    if ($sp) { $sp.SetScrollPercent(-1, 0); Start-Sleep -Milliseconds 200 }

    $pageData = @{}
    $prevCount = -1
    $staleCount = 0
    $scrolls = 0

    while ($scrolls -lt 2000) {
        $rows = $grid.FindAll([System.Windows.Automation.TreeScope]::Children, $rowCond)
        foreach ($row in $rows) {
            $cells = $row.FindAll([System.Windows.Automation.TreeScope]::Children, [System.Windows.Automation.Condition]::TrueCondition)
            if ($cells.Count -ge 4) {
                $name = $cells[2].Current.Name
                $freq = $cells[3].Current.Name
                if ($name -and $freq -and $name -ne "Name" -and -not $pageData.ContainsKey($name)) {
                    $pageData[$name] = $freq
                }
            }
        }

        if ($pageData.Count -eq $prevCount) {
            $staleCount++
            if ($staleCount -ge 5) { break }
        } else {
            $staleCount = 0
        }
        $prevCount = $pageData.Count

        if ($sp) {
            $sp.Scroll([System.Windows.Automation.ScrollAmount]::NoAmount, [System.Windows.Automation.ScrollAmount]::SmallIncrement)
            Start-Sleep -Milliseconds 50
        } else { break }
        $scrolls++
    }
    return $pageData
}

# Loop through pages
while ($page -le 200) {
    Write-Host ("Page {0}..." -f $page)

    $pageData = Read-VisibleRows $grid $rowCond
    $newCount = 0

    foreach ($key in $pageData.Keys) {
        if (-not $allData.ContainsKey($key)) {
            $allData[$key] = $pageData[$key]
            "$key,$($pageData[$key])" | Out-File $outputFile -Append -Encoding UTF8
            $newCount++
        }
    }

    $totalRows += $newCount
    Write-Host ("  Got {0} new rows (total: {1})" -f $newCount, $totalRows)

    if ($newCount -eq 0) { break }

    # Click Next
    if ($nextBtn) {
        try {
            $invokePattern = $nextBtn.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern)
            $invokePattern.Invoke()
            Start-Sleep -Milliseconds 800
        } catch {
            Write-Host "  Could not click Next"
            break
        }
    } else {
        Write-Host "  Next button not found"
        break
    }

    $page++
}

Write-Host ("`nScraping done! {0} total stations" -f $totalRows)

# Convert frequencies from Hz (125000000) to MHz (125.000)
Write-Host "Converting frequencies..."
$lines = Get-Content $outputFile
$converted = @()
$converted += "Name,Frequency"
foreach ($line in $lines | Select-Object -Skip 1) {
    if ($line -match "^(.+),(\d{6,})$") {
        $name = $Matches[1]
        $freqHz = [long]$Matches[2]
        $freqMhz = ($freqHz / 1000000).ToString("0.000")
        $converted += "$name,$freqMhz"
    } elseif ($line.Trim()) {
        $converted += $line
    }
}
$converted | Out-File $outputFile -Encoding UTF8
Write-Host ("Done! {0} stations saved to {1}" -f $totalRows, $outputFile)
