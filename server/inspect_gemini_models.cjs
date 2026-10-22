const { chromium } = require('playwright');

(async () => {
  try {
    const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
    const page = browser.contexts()[0].pages().find(p => p.url().includes('gemini.google.com'));

    const pickerBtn = await page.$('button[aria-label*="mode picker"], button:has-text("Gemini")');
    if (pickerBtn) {
      console.log('Clicking mode picker button...');
      await pickerBtn.click();
      await page.waitForTimeout(500);

      // Check opened menu options
      const menuItems = await page.$$eval('[role="menuitem"], [role="option"], .mat-mdc-menu-item, .mode-option', els => els.map(e => ({
        text: e.innerText?.trim(),
        ariaLabel: e.getAttribute('aria-label'),
        role: e.getAttribute('role')
      })));
      console.log('Mode picker menu items:', JSON.stringify(menuItems, null, 2));

      // Close menu by clicking outside or pressing Escape
      await page.keyboard.press('Escape');
    }
    await browser.close();
  } catch (e) {
    console.error(e);
  }
})();
