
Add-Type @"
  using System;
  using System.Runtime.InteropServices;
  using System.Text;

  public class WinEnum {
    public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

    [DllImport("user32.dll")]
    public static extern bool EnumWindows(EnumWindowsProc enumProc, IntPtr lParam);

    [DllImport("user32.dll")]
    public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);

    [DllImport("user32.dll")]
    public static extern bool IsWindowVisible(IntPtr hWnd);

    [DllImport("user32.dll", CharSet = CharSet.Auto)]
    public static extern int GetWindowText(IntPtr hWnd, StringBuilder strText, int maxCount);

    public static void ListWindows(uint targetPid) {
      EnumWindows((hWnd, lParam) => {
        uint pid;
        GetWindowThreadProcessId(hWnd, out pid);
        if (pid == targetPid) {
          StringBuilder sb = new StringBuilder(256);
          GetWindowText(hWnd, sb, 256);
          bool visible = IsWindowVisible(hWnd);
          Console.WriteLine("HWND: " + hWnd + " Visible: " + visible + " Title: [" + sb.ToString() + "]");
        }
        return true;
      }, IntPtr.Zero);
    }
  }
"@

[WinEnum]::ListWindows(1664)
