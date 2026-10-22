const { chromium } = require('playwright');

(async () => {
  try {
    const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
    const page = browser.contexts()[0].pages().find(p => p.url().includes('gemini.google.com'));

    const containers = await page.$$eval('message-content, .model-response-text, .response-container-content, [id*="message-content"], .markdown, model-response', els => els.map(e => ({
      tagName: e.tagName,
      className: e.className,
      text: e.innerText?.slice(0, 50)
    })));
    console.log('Containers:', JSON.stringify(containers, null, 2));

    await browser.close();
  } catch (err) {
    console.error('Error:', err);
  }
})();
