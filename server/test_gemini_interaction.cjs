const { chromium } = require('playwright');

(async () => {
  try {
    const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
    const page = browser.contexts()[0].pages().find(p => p.url().includes('gemini.google.com'));

    console.log('Testing typing into Gemini input...');
    const input = page.locator('div.ql-editor[role="textbox"]');
    await input.click();
    await input.fill('Say exactly: FreeLLM Gemini is working!');
    await page.waitForTimeout(500);

    // Check send button
    const sendBtn = await page.$('button[aria-label*="Send message"], button.send-button, [aria-label*="Submit"]');
    console.log('Send button found after typing:', !!sendBtn);
    if (sendBtn) {
      console.log('Clicking send button...');
      await sendBtn.click();
    } else {
      console.log('Pressing Enter...');
      await page.keyboard.press('Enter');
    }

    console.log('Waiting for response...');
    for (let i = 0; i < 15; i++) {
      await page.waitForTimeout(1000);
      const responses = await page.$$eval('message-content, .model-response-text, model-response, [class*="response"], markdown', els => els.map(e => ({
        tag: e.tagName,
        cls: e.className?.slice(0, 30),
        text: e.innerText?.slice(0, 100)
      })));
      const filtered = responses.filter(r => r.text && r.text.length > 5);
      if (filtered.length > 0) {
        console.log(`Second ${i + 1} response candidates:`, JSON.stringify(filtered, null, 2));
        break;
      }
    }

    await browser.close();
  } catch (err) {
    console.error('Error:', err);
  }
})();
