# Create the Deployment folder
$deploymentFolderPath = "C:\Windows\Setup\Scripts\Deployment"
New-Item -Path $deploymentFolderPath -ItemType Directory -Force

# Set the folder attribute to hidden
$folder = Get-Item $deploymentFolderPath
$folder.Attributes += 'Hidden'

# Output to confirm completion
Write-Host "Deployment folder created and hidden successfully."
