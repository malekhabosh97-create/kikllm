import os
import subprocess
from pathlib import Path
from typing import List, Dict, Any, Optional

class WorkspaceManager:
    def __init__(self, workspace_root: Optional[str] = None):
        if workspace_root is None:
            # Default to a dedicated workspace folder inside freellm work
            base = Path(__file__).resolve().parent.parent.parent
            workspace_root = str(base / "workspace")
        self.root = Path(workspace_root).resolve()
        self.root.mkdir(parents=True, exist_ok=True)

    def set_root(self, path: str):
        p = Path(path).resolve()
        if p.exists() and p.is_dir():
            self.root = p
            return True
        return False

    def list_files(self, rel_path: str = "") -> List[Dict[str, Any]]:
        target = (self.root / rel_path).resolve()
        if not target.exists() or not target.is_dir():
            return []

        results = []
        try:
            for item in sorted(target.iterdir()):
                # Skip hidden/large folders
                if item.name.startswith(".") or item.name in ["node_modules", "__pycache__", "dist"]:
                    continue
                results.append({
                    "name": item.name,
                    "path": str(item.relative_to(self.root)).replace("\\", "/"),
                    "is_dir": item.is_dir(),
                    "size": item.stat().st_size if item.is_file() else 0
                })
        except Exception as e:
            print(f"Error listing files: {e}")
        return results

    def read_file(self, rel_path: str) -> str:
        target = (self.root / rel_path).resolve()
        if not target.exists() or not target.is_file():
            raise FileNotFoundError(f"File not found: {rel_path}")
        return target.read_text(encoding="utf-8", errors="replace")

    def write_file(self, rel_path: str, content: str) -> str:
        target = (self.root / rel_path).resolve()
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(content, encoding="utf-8")
        return f"Successfully wrote to {rel_path}"

    def run_command(self, command: str) -> Dict[str, Any]:
        try:
            proc = subprocess.run(
                command,
                shell=True,
                cwd=str(self.root),
                capture_output=True,
                text=True,
                timeout=60
            )
            return {
                "exit_code": proc.returncode,
                "stdout": proc.stdout,
                "stderr": proc.stderr
            }
        except subprocess.TimeoutExpired:
            return {"exit_code": -1, "stdout": "", "stderr": "Command timed out after 60s"}
        except Exception as e:
            return {"exit_code": -1, "stdout": "", "stderr": str(e)}
