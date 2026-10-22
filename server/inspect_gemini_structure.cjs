const { chromium } = require('playwright');

(async () => {
  try {
    const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
    const page = browser.contexts()[0].pages().find(p => p.url().includes('gemini.google.com'));

    const tags = await page.$$eval('*', els => {
      const set = new Set();
      for (const el of els) {
        if (el.tagName.includes('-')) set.add(el.tagName.toLowerCase());
      }
      return Array.from(set);
    });
    console.log('Custom elements on Gemini:', tags.filter(t => t.includes('chat') || t.includes('response') || t.includes('message') || t.includes('conversation') || t.includes('model') || t.includes('turn')));

    await browser.close();
  } catch (err) {
    console.error('Error:', err);
  }
})();
