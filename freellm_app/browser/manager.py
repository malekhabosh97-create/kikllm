import asyncio
import os
import sys
from pathlib import Path
from typing import Optional, Dict, Any, AsyncGenerator
from playwright.async_api import async_playwright, BrowserContext, Page, Playwright

class BrowserManager:
    _instance: Optional['BrowserManager'] = None

    def __init__(self, profile_dir: Optional[str] = None):
        if profile_dir is None:
            base = Path(__file__).resolve().parent.parent.parent
            profile_dir = str(base / ".browser-profile")
        self.profile_dir = Path(profile_dir)
        self.profile_dir.mkdir(parents=True, exist_ok=True)
        
        self.playwright: Optional[Playwright] = None
        self.context: Optional[BrowserContext] = None
        self.active_pages: Dict[str, Page] = {}
        self.is_running = False

    @classmethod
    def get_instance(cls) -> 'BrowserManager':
        if cls._instance is None:
            cls._instance = BrowserManager()
        return cls._instance

    async def initialize(self, headless: bool = True):
        if self.context and self.is_running:
            return self.context
            
        self.playwright = await async_playwright().start()
        
        # Launch Chromium with persistent context to preserve cookies & logins
        self.context = await self.playwright.chromium.launch_persistent_context(
            user_data_dir=str(self.profile_dir),
            headless=headless,
            channel="chrome" if os.path.exists("C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe") else None,
            args=[
                "--disable-blink-features=AutomationControlled",
                "--no-sandbox",
                "--disable-infobars",
                "--start-maximized"
            ],
            viewport=None,
            user_agent="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
        )
        self.is_running = True
        return self.context

    async def open_login_window(self):
        """Opens a visible browser with tabs for DeepSeek, Gemini, and Arena for one-time login."""
        # If currently running in headless, close and reopen visible
        if self.context and self.is_running:
            await self.close()

        context = await self.initialize(headless=False)
        
        # Open DeepSeek
        p_deepseek = await context.new_page()
        await p_deepseek.goto("https://chat.deepseek.com", wait_until="domcontentloaded")
        self.active_pages["deepseek"] = p_deepseek

        # Open Gemini
        p_gemini = await context.new_page()
        await p_gemini.goto("https://gemini.google.com", wait_until="domcontentloaded")
        self.active_pages["gemini"] = p_gemini

        # Open Arena
        p_arena = await context.new_page()
        await p_arena.goto("https://lmarena.ai", wait_until="domcontentloaded")
        self.active_pages["arena"] = p_arena

        return {
            "status": "opened",
            "message": "Browser opened. Please login to your accounts in the tabs. Your sessions will be saved permanently."
        }

    async def get_page(self, service: str) -> Page:
        if not self.context or not self.is_running:
            await self.initialize(headless=False)

        urls = {
            "deepseek": "https://chat.deepseek.com",
            "gemini": "https://gemini.google.com",
            "arena": "https://lmarena.ai"
        }

        # Check existing pages in context
        for p in self.context.pages:
            url = p.url.lower()
            if service in url or (service == "arena" and "lmarena" in url):
                self.active_pages[service] = p
                return p

        # Otherwise create a new page and navigate
        target_url = urls.get(service, "https://chat.deepseek.com")
        page = await self.context.new_page()
        await page.goto(target_url, wait_until="domcontentloaded")
        self.active_pages[service] = page
        return page

    async def ask_deepseek(self, prompt: str) -> AsyncGenerator[str, None]:
        page = await self.get_page("deepseek")
        await page.bring_to_front()
        
        # Wait for input box
        textarea = await page.wait_for_selector("textarea", timeout=15000)
        await textarea.fill(prompt)
        await asyncio.sleep(0.3)
        await page.keyboard.press("Enter")

        # Wait for response generation to start and complete
        # Polling message bubble
        last_text = ""
        stable_count = 0
        
        for _ in range(120): # up to 120 seconds
            await asyncio.sleep(1.0)
            # Find the last message element
            messages = await page.query_selector_all(".ds-markdown, .fbb737a4")
            if messages:
                current_text = await messages[-1].inner_text()
                if current_text != last_text:
                    diff = current_text[len(last_text):]
                    last_text = current_text
                    stable_count = 0
                    yield diff
                else:
                    stable_count += 1
                    # If text hasn't changed for 3 seconds and there's no stop button
                    stop_btn = await page.query_selector("button[aria-label*='Stop'], .ds-icon--stop")
                    if not stop_btn and stable_count >= 3 and len(last_text) > 0:
                        break

    async def ask_gemini(self, prompt: str) -> AsyncGenerator[str, None]:
        page = await self.get_page("gemini")
        await page.bring_to_front()

        # Find input box
        input_box = await page.wait_for_selector("rich-textarea, div[contenteditable='true'], textarea", timeout=15000)
        await input_box.click()
        await page.keyboard.insert_text(prompt)
        await asyncio.sleep(0.3)
        await page.keyboard.press("Enter")

        last_text = ""
        stable_count = 0
        for _ in range(120):
            await asyncio.sleep(1.0)
            responses = await page.query_selector_all("message-content, .model-response-text")
            if responses:
                current_text = await responses[-1].inner_text()
                if current_text != last_text:
                    diff = current_text[len(last_text):]
                    last_text = current_text
                    stable_count = 0
                    yield diff
                else:
                    stable_count += 1
                    if stable_count >= 3 and len(last_text) > 0:
                        break

    async def ask_arena(self, prompt: str) -> AsyncGenerator[str, None]:
        page = await self.get_page("arena")
        await page.bring_to_front()

        textbox = await page.wait_for_selector("textarea", timeout=15000)
        await textbox.fill(prompt)
        await asyncio.sleep(0.3)
        await page.keyboard.press("Enter")

        last_text = ""
        stable_count = 0
        for _ in range(120):
            await asyncio.sleep(1.0)
            messages = await page.query_selector_all("div.message-content, .prose, .markdown-body")
            if messages:
                current_text = await messages[-1].inner_text()
                if current_text != last_text:
                    diff = current_text[len(last_text):]
                    last_text = current_text
                    stable_count = 0
                    yield diff
                else:
                    stable_count += 1
                    if stable_count >= 3 and len(last_text) > 0:
                        break

    async def close(self):
        if self.context:
            await self.context.close()
            self.context = None
        if self.playwright:
            await self.playwright.stop()
            self.playwright = None
        self.is_running = False
        self.active_pages.clear()
