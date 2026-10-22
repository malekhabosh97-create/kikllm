import sys
import webbrowser
import subprocess
from pathlib import Path

def main():
    root_dir = Path(__file__).resolve().parent
    venv_python = root_dir / ".venv" / "Scripts" / "python.exe"

    if not venv_python.exists():
        python_exec = sys.executable
    else:
        python_exec = str(venv_python)

    print("=" * 60)
    print("🚀 Starting FreeLLM Work Studio...")
    print("=" * 60)
    print("📍 URL: http://127.0.0.1:8000")
    print("📁 Workspace: C:\\Users\\malek\\Documents\\freellm work\\workspace")
    print("⚡ Skills & Browser Automation Engine ready.")
    print("=" * 60)

    # Open browser automatically after a short delay
    def open_browser():
        import time
        time.sleep(1.5)
        webbrowser.open("http://127.0.0.1:8000")

    import threading
    threading.Thread(target=open_browser, daemon=True).start()

    # Run uvicorn
    cmd = [
        python_exec,
        "-m",
        "uvicorn",
        "freellm_app.server.main:app",
        "--host",
        "127.0.0.1",
        "--port",
        "8000"
    ]
    subprocess.run(cmd, cwd=str(root_dir))

if __name__ == "__main__":
    main()
