import os
import re
from pathlib import Path
from typing import Dict, List, Optional
from pydantic import BaseModel

class Skill(BaseModel):
    name: str
    description: str
    path: str
    content: str
    enabled: bool = True

class SkillsManager:
    def __init__(self, skills_dir: Optional[str] = None):
        if skills_dir is None:
            # Default to skills folder in root of freellm work
            base = Path(__file__).resolve().parent.parent.parent
            skills_dir = str(base / "skills")
        self.skills_dir = Path(skills_dir)
        self.skills: Dict[str, Skill] = {}
        self.load_skills()

    def parse_skill_md(self, skill_path: Path) -> Optional[Skill]:
        skill_file = skill_path / "SKILL.md"
        if not skill_file.exists():
            return None
        try:
            content = skill_file.read_text(encoding="utf-8")
            # Parse YAML frontmatter
            name = skill_path.name
            description = ""
            
            frontmatter_match = re.match(r"^---\s*\n(.*?)\n---\s*\n(.*)$", content, re.DOTALL)
            if frontmatter_match:
                frontmatter = frontmatter_match.group(1)
                body = frontmatter_match.group(2)
                
                # Simple extraction for name and description
                for line in frontmatter.splitlines():
                    if line.startswith("name:"):
                        name = line.split(":", 1)[1].strip()
                    elif line.startswith("description:"):
                        description = line.split(":", 1)[1].strip().strip(">").strip()
            else:
                body = content
                
            return Skill(
                name=name,
                description=description or f"Skill: {name}",
                path=str(skill_path),
                content=content,
                enabled=True
            )
        except Exception as e:
            print(f"Error reading skill {skill_path}: {e}")
            return None

    def load_skills(self) -> Dict[str, Skill]:
        self.skills = {}
        if not self.skills_dir.exists():
            return self.skills

        for item in self.skills_dir.iterdir():
            if item.is_dir() and (item / "SKILL.md").exists():
                skill = self.parse_skill_md(item)
                if skill:
                    self.skills[skill.name] = skill
        return self.skills

    def get_active_skills(self) -> List[Skill]:
        return [s for s in self.skills.values() if s.enabled]

    def set_skill_status(self, name: str, enabled: bool) -> bool:
        if name in self.skills:
            self.skills[name].enabled = enabled
            return True
        return False

    def build_system_prompt_extension(self) -> str:
        active = self.get_active_skills()
        if not active:
            return ""

        prompt = "\n\n### ACTIVE WORKSPACE SKILLS & CAPABILITIES ###\n"
        prompt += "You have the following specialized skills available to guide your step-by-step thinking:\n\n"
        for s in active:
            prompt += f"#### Skill: {s.name}\n{s.description}\n"
            # Include relevant instruction summaries
            summary_lines = [l for l in s.content.splitlines() if not l.startswith("---")][:15]
            prompt += "\n".join(summary_lines) + "\n\n"
        return prompt
