
Add-Type @"
  using System;
  using System.Runtime.InteropServices;
  using System.Text;

  public class WinFind {
    public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

    [DllImport("user32.dll")]
    public static extern bool EnumWindows(EnumWindowsProc enumProc, IntPtr lParam);

    [DllImport("user32.dll")]
    public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);

    [DllImport("user32.dll")]
    public static extern bool IsWindowVisible(IntPtr hWnd);

    [DllImport("user32.dll", CharSet = CharSet.Auto)]
    public static extern int GetWindowText(IntPtr hWnd, StringBuilder strText, int maxCount);

    [DllImport("user32.dll", CharSet = CharSet.Auto)]
    public static extern int GetClassName(IntPtr hWnd, StringBuilder strClassName, int maxCount);

    public static void FindAll() {
      EnumWindows((hWnd, lParam) => {
        StringBuilder cn = new StringBuilder(256);
        GetClassName(hWnd, cn, 256);
        string className = cn.ToString();
        if (className.Contains("Chrome_WidgetWin")) {
          uint pid;
          GetWindowThreadProcessId(hWnd, out pid);
          StringBuilder title = new StringBuilder(256);
          GetWindowText(hWnd, title, 256);
          bool visible = IsWindowVisible(hWnd);
          Console.WriteLine("HWND: " + hWnd + " PID: " + pid + " Class: " + className + " Visible: " + visible + " Title: [" + title.ToString() + "]");
        }
        return true;
      }, IntPtr.Zero);
    }
  }
"@

[WinFind]::FindAll()
