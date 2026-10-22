import os
import sys
import json
import asyncio
from pathlib import Path
from typing import Optional, List, Dict, Any
from fastapi import FastAPI, HTTPException, Query, Body
from fastapi.staticfiles import StaticFiles
from fastapi.responses import HTMLResponse, StreamingResponse
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

# Add parent path to allow imports
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from browser.manager import BrowserManager
from skills.manager import SkillsManager
from workspace.manager import WorkspaceManager

app = FastAPI(title="FreeLLM Work API", version="1.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

browser_mgr = BrowserManager.get_instance()
skills_mgr = SkillsManager()
workspace_mgr = WorkspaceManager()

class ChatRequest(BaseModel):
    model: str = "deepseek" # "deepseek", "gemini", "arena"
    prompt: str
    include_skills: bool = True
    include_workspace_context: bool = True

class ToggleSkillRequest(BaseModel):
    enabled: bool

class WriteFileRequest(BaseModel):
    path: str
    content: str

@app.get("/api/status")
async def get_status():
    return {
        "status": "online",
        "browser_running": browser_mgr.is_running,
        "workspace_root": str(workspace_mgr.root),
        "available_models": [
            {"id": "deepseek", "name": "DeepSeek (chat.deepseek.com)", "tag": "Free & Smart"},
            {"id": "gemini", "name": "Google Gemini (gemini.google.com)", "tag": "Free & Fast"},
            {"id": "arena", "name": "LMSYS Arena (lmarena.ai)", "tag": "Multi-Model Hub"}
        ],
        "active_skills": len(skills_mgr.get_active_skills())
    }

@app.post("/api/browser/open-login")
async def open_login():
    """Opens visible browser window for one-time login."""
    try:
        res = await browser_mgr.open_login_window()
        return res
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.get("/api/skills")
def list_skills():
    return [
        {
            "name": s.name,
            "description": s.description,
            "enabled": s.enabled
        }
        for s in skills_mgr.skills.values()
    ]

@app.post("/api/skills/{name}/toggle")
def toggle_skill(name: str, req: ToggleSkillRequest):
    success = skills_mgr.set_skill_status(name, req.enabled)
    if not success:
        raise HTTPException(status_code=404, detail="Skill not found")
    return {"name": name, "enabled": req.enabled}

@app.get("/api/workspace/files")
def list_workspace_files(path: str = ""):
    return workspace_mgr.list_files(path)

@app.get("/api/workspace/file")
def read_workspace_file(path: str = Query(..., description="Relative path")):
    try:
        content = workspace_mgr.read_file(path)
        return {"path": path, "content": content}
    except Exception as e:
        raise HTTPException(status_code=404, detail=str(e))

@app.post("/api/workspace/file")
def write_workspace_file(req: WriteFileRequest):
    try:
        msg = workspace_mgr.write_file(req.path, req.content)
        return {"status": "success", "message": msg}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.post("/api/workspace/run")
def run_workspace_command(cmd: str = Body(..., embed=True)):
    return workspace_mgr.run_command(cmd)

@app.post("/api/chat")
async def chat_stream(req: ChatRequest):
    # Construct prompt with workspace context and skills
    full_prompt = req.prompt
    
    if req.include_skills:
        skills_context = skills_mgr.build_system_prompt_extension()
        if skills_context:
            full_prompt = f"{skills_context}\n\nUSER REQUEST:\n{full_prompt}"
            
    if req.include_workspace_context:
        files = workspace_mgr.list_files()
        file_list_str = "\n".join([f"- {f['name']} ({'DIR' if f['is_dir'] else 'FILE'})" for f in files])
        full_prompt = f"Workspace Root: {workspace_mgr.root}\nFiles in workspace:\n{file_list_str}\n\n{full_prompt}"

    async def event_generator():
        try:
            generator = None
            if req.model == "deepseek":
                generator = browser_mgr.ask_deepseek(full_prompt)
            elif req.model == "gemini":
                generator = browser_mgr.ask_gemini(full_prompt)
            elif req.model == "arena":
                generator = browser_mgr.ask_arena(full_prompt)
            else:
                generator = browser_mgr.ask_deepseek(full_prompt)

            async for chunk in generator:
                yield f"data: {json.dumps({'chunk': chunk})}\n\n"
            yield f"data: {json.dumps({'done': True})}\n\n"
        except Exception as e:
            yield f"data: {json.dumps({'error': str(e)})}\n\n"

    return StreamingResponse(event_generator(), media_type="text/event-stream")

# Mount static folder
static_dir = Path(__file__).resolve().parent.parent / "static"
static_dir.mkdir(parents=True, exist_ok=True)
app.mount("/static", StaticFiles(directory=str(static_dir)), name="static")

@app.get("/")
def serve_home():
    index_file = static_dir / "index.html"
    if index_file.exists():
        return HTMLResponse(content=index_file.read_text(encoding="utf-8"))
    return HTMLResponse("<h1>FreeLLM Work is starting up...</h1>")
