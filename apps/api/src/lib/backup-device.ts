import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import { promisify } from "node:util";
import { z } from "zod";

const execFileAsync = promisify(execFile);
export type PhysicalDeviceRelation = "same" | "different" | "unknown";

// Constant PowerShell source. Paths travel as execFile arguments, never through a shell string.
const windowsDiskQuery = String.raw`
$paths = @($args[0], $args[1])
$volumes = @(Get-CimInstance Win32_Volume -ErrorAction Stop)
$numbers = @()
foreach ($target in $paths) {
  $volume = $volumes | Where-Object { $_.Name -and $target.StartsWith($_.Name, [StringComparison]::OrdinalIgnoreCase) } | Sort-Object { $_.Name.Length } -Descending | Select-Object -First 1
  if ($null -eq $volume) { $numbers += $null; continue }
  try {
    $partition = Get-Partition -ErrorAction Stop | Where-Object { $_.AccessPaths -contains $volume.DeviceID } | Select-Object -First 1
    if ($null -eq $partition) { $numbers += $null } else { $numbers += [string]$partition.DiskNumber }
  } catch { $numbers += $null }
}
ConvertTo-Json -InputObject $numbers -Compress
`;
const diskNumbersSchema = z.array(z.string().nullable()).length(2);

export function compareWindowsDiskNumbers(numbers: readonly (string | null)[]): PhysicalDeviceRelation {
  if (numbers.length !== 2 || numbers[0] === null || numbers[1] === null || numbers[0] === undefined || numbers[1] === undefined) {
    return "unknown";
  }
  return numbers[0] === numbers[1] ? "same" : "different";
}

/** Compare physical disks without guessing from drive letters or probing removable media during status reads. */
export async function comparePhysicalDevice(
  dataDir: string,
  destination: string,
  platform: NodeJS.Platform = process.platform,
): Promise<PhysicalDeviceRelation> {
  if (platform === "win32") {
    try {
      const result = await execFileAsync(
        "powershell.exe",
        ["-NoProfile", "-NonInteractive", "-Command", windowsDiskQuery, dataDir, destination],
        { timeout: 2500, maxBuffer: 2048, windowsHide: true },
      );
      const parsed = diskNumbersSchema.safeParse(JSON.parse(result.stdout));
      return parsed.success ? compareWindowsDiskNumbers(parsed.data) : "unknown";
    } catch {
      // Network roots, mounted paths, unavailable PowerShell and policy refusal stay unknown.
      return "unknown";
    }
  }
  if (platform === "linux" || platform === "darwin" || platform === "freebsd") {
    try {
      const [sourceStat, destinationStat] = await Promise.all([fs.stat(dataDir), fs.stat(destination)]);
      return sourceStat.dev === destinationStat.dev ? "same" : "unknown";
    } catch {
      return "unknown";
    }
  }
  return "unknown";
}
