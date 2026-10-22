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

    console.log('Gemini Page Title:', await page.title());
    console.log('Gemini Page URL:', page.url());

    // Check login buttons
    const signinButtons = await page.$$eval('a[href*="accounts.google.com"], button:has-text("Sign in")', els => els.map(e => e.outerHTML));
    console.log('Sign in buttons found:', signinButtons.length);

    // Check input elements
    const inputs = await page.$$eval('rich-textarea, div[contenteditable="true"], div[role="textbox"], textarea', els => els.map(e => ({
      tagName: e.tagName,
      className: e.className,
      role: e.getAttribute('role'),
      contentEditable: e.getAttribute('contenteditable'),
      ariaLabel: e.getAttribute('aria-label'),
      placeholder: e.getAttribute('placeholder')
    })));
    console.log('Input candidates:', JSON.stringify(inputs, null, 2));

    // Check send buttons
    const sendButtons = await page.$$eval('button[aria-label*="Send"], button[aria-label*="Submit"], button.send-button, [data-test-id*="send"]', els => els.map(e => ({
      tagName: e.tagName,
      className: e.className,
      ariaLabel: e.getAttribute('aria-label')
    })));
    console.log('Send button candidates:', JSON.stringify(sendButtons, null, 2));

    // Check message containers
    const messageContainers = await page.$$eval('.model-response-text, message-content, .response-container, response-container', els => els.map(e => ({
      tagName: e.tagName,
      className: e.className
    })));
    console.log('Message containers found:', messageContainers.length);

    // Check model picker (e.g. 2.0 Flash / 1.5 Pro / Advanced)
    const modelPicker = await page.$$eval('button[aria-label*="model"], [data-test-id*="model-picker"], button:has-text("Flash"), button:has-text("Pro"), button:has-text("Advanced")', els => els.map(e => ({
      text: e.innerText,
      ariaLabel: e.getAttribute('aria-label')
    })));
    console.log('Model pickers found:', JSON.stringify(modelPicker, null, 2));

    await browser.close();
  } catch (err) {
    console.error('Error inspecting Gemini DOM:', err);
  }
})();
