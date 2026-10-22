const { chromium } = require('playwright');

(async () => {
  try {
    const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
    const page = browser.contexts()[0].pages().find(p => p.url().includes('gemini.google.com'));

    const signin = await page.$$eval('a[href*="accounts.google.com"], button:has-text("Sign in")', els => els.map(e => ({
      text: e.innerText,
      href: e.href,
      isVisible: e.offsetWidth > 0 && e.offsetHeight > 0
    })));
    console.log('Sign in details:', JSON.stringify(signin, null, 2));

    const avatars = await page.$$eval('a[aria-label*="Google Account"], img[alt*="Profile"], [aria-label*="Google Account"]', els => els.map(e => e.getAttribute('aria-label') || e.getAttribute('alt')));
    console.log('Avatars / Account:', JSON.stringify(avatars, null, 2));

    const allButtons = await page.$$eval('button', els => els.map(e => ({
      text: e.innerText?.slice(0, 30),
      ariaLabel: e.getAttribute('aria-label'),
      className: e.className?.slice(0, 40)
    })).filter(b => b.ariaLabel || b.text));
    console.log('Sample buttons:', JSON.stringify(allButtons.slice(0, 15), null, 2));

    await browser.close();
  } catch (err) {
    console.error('Error:', err);
  }
})();
