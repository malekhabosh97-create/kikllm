const { chromium } = require('playwright');

(async () => {
  try {
    const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
    const page = browser.contexts()[0].pages().find(p => p.url().includes('gemini.google.com'));

    // Check what elements are inside or next to rich-textarea
    const inputContainer = await page.$('rich-textarea');
    if (inputContainer) {
      console.log('Found rich-textarea!');
      const editor = await page.$('div.ql-editor[role="textbox"]');
      console.log('Found editor:', !!editor);

      // Check send button in DOM
      const sendBtn = await page.$('button[aria-label*="Send message"], button.send-button, [aria-label*="Submit"]');
      console.log('Send button initially:', !!sendBtn);

      // Check all buttons around input-area
      const areaButtons = await page.$$eval('.input-area button, rich-textarea button, .bottom-container button', els => els.map(e => ({
        ariaLabel: e.getAttribute('aria-label'),
        text: e.innerText?.slice(0, 30),
        className: e.className?.slice(0, 30)
      })));
      console.log('Buttons near input:', JSON.stringify(areaButtons, null, 2));
    }

    await browser.close();
  } catch (err) {
    console.error('Error:', err);
  }
})();
