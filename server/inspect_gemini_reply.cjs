const { chromium } = require('playwright');

(async () => {
  try {
    const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
    const page = browser.contexts()[0].pages().find(p => p.url().includes('gemini.google.com'));
    const texts = await page.$$eval('.response-content, message-content, model-response, .model-response-text', els => els.map(e => ({
      tag: e.tagName,
      cls: e.className,
      text: e.innerText
    })));
    console.log('Gemini actual responses:', JSON.stringify(texts.filter(t => t.text && t.text.length > 5), null, 2));
    await browser.close();
  } catch (e) {
    console.error(e);
  }
})();
