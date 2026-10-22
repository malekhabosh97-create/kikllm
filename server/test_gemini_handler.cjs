const { chromium } = require('playwright');

(async () => {
  try {
    const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
    const page = browser.contexts()[0].pages().find(p => p.url().includes('gemini.google.com'));
    if (!page) {
      console.log('Gemini page not found');
      await browser.close();
      return;
    }

    console.log('Found Gemini page. Testing checkStatus...');
    const url = page.url();
    const input = await page.$('rich-textarea, div.ql-editor[role="textbox"]');
    console.log('Input present?', !!input);

    const pickerBtn = await page.$('button[aria-label*="mode picker"], button:has-text("Gemini")');
    if (pickerBtn) {
      console.log('Mode picker text:', (await pickerBtn.innerText()).trim());
    }

    console.log('Gemini status: READY');
    await browser.close();
  } catch (e) {
    console.error('Error:', e);
  }
})();
