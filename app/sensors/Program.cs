using System.Globalization;
using System.Text;
using LibreHardwareMonitor.Hardware;

// Kraken Host sensor helper: prints one JSON line per second with CPU and GPU readings, e.g.
//   {"cpu":{"temp":null,"load":16.1},"gpu":{"temp":43.0,"load":23.0,"name":"AMD Radeon RX 7600 XT"}}
// Read-only: it only reads sensors. CPU temperature on Ryzen needs the PawnIO driver and admin
// rights; without them it is reported as null and the display shows "–" for it.
// Exits when stdin closes, so it never outlives the app that started it.

var computer = new Computer { IsCpuEnabled = true, IsGpuEnabled = true };
computer.Open();

var parentGone = new CancellationTokenSource();
new Thread(() =>
{
    try { while (Console.In.Read() != -1) { } } catch { }
    parentGone.Cancel();
}) { IsBackground = true }.Start();

static float? Pick(IHardware hw, SensorType type, params string[] names)
{
    foreach (var name in names)
    {
        var s = hw.Sensors.FirstOrDefault(x => x.SensorType == type && x.Name == name);
        if (s?.Value is float v && v > 0 && v < 150) return v;   // 0 means "can't read" here
    }
    return null;
}

static string Num(float? v) => v.HasValue ? v.Value.ToString("0.0", CultureInfo.InvariantCulture) : "null";

static string Str(string s) => "\"" + s.Replace("\\", "\\\\").Replace("\"", "\\\"") + "\"";

while (!parentGone.IsCancellationRequested)
{
    float? cpuTemp = null, cpuLoad = null, gpuTemp = null, gpuLoad = null;
    string gpuName = "";

    foreach (var hw in computer.Hardware)
    {
        if (hw.HardwareType == HardwareType.Cpu && cpuLoad == null)
        {
            hw.Update();
            cpuTemp = Pick(hw, SensorType.Temperature, "Core (Tctl/Tdie)", "CPU Package", "Core (Tctl)", "Core Average", "CPU Cores");
            cpuLoad = Pick(hw, SensorType.Load, "CPU Total");
        }
        // Prefer a discrete GPU; fall back to integrated graphics if that's all there is.
        else if (hw.HardwareType is HardwareType.GpuAmd or HardwareType.GpuNvidia
                 || (hw.HardwareType == HardwareType.GpuIntel && gpuTemp == null))
        {
            hw.Update();
            var t = Pick(hw, SensorType.Temperature, "GPU Core", "GPU Temperature");
            if (t == null && gpuTemp != null) continue;
            gpuTemp = t;
            gpuLoad = Pick(hw, SensorType.Load, "GPU Core", "D3D 3D");
            gpuName = hw.Name;
        }
    }

    var line = new StringBuilder()
        .Append("{\"cpu\":{\"temp\":").Append(Num(cpuTemp)).Append(",\"load\":").Append(Num(cpuLoad))
        .Append("},\"gpu\":{\"temp\":").Append(Num(gpuTemp)).Append(",\"load\":").Append(Num(gpuLoad))
        .Append(",\"name\":").Append(Str(gpuName)).Append("}}");
    Console.Out.WriteLine(line);
    Console.Out.Flush();

    parentGone.Token.WaitHandle.WaitOne(1000);
}

computer.Close();
