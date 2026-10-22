const { chromium } = require('playwright');

(async () => {
  try {
    const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
    const contexts = browser.contexts();
    const pages = contexts[0].pages();
    console.log('Total pages:', pages.length);
    for (let i = 0; i < pages.length; i++) {
      console.log(`Page ${i}: URL=${pages[i].url()} Title=${await pages[i].title()}`);
    }

    if (pages.length > 0) {
      const page = pages[0];
      const session = await contexts[0].newCDPSession(page);
      const { windowId } = await session.send('Browser.getWindowForTarget');
      const bounds = await session.send('Browser.getWindowBounds', { windowId });
      console.log('Window ID:', windowId);
      console.log('Current Window Bounds & State:', JSON.stringify(bounds));

      // Try setting window to normal and bringing it to screen coordinates (100, 100, 1200, 800)
      console.log('Attempting to reposition window to normal (100, 100, 1200, 800)...');
      await session.send('Browser.setWindowBounds', {
        windowId,
        bounds: {
          left: 100,
          top: 100,
          width: 1200,
          height: 800,
          windowState: 'normal'
        }
      });
      await page.bringToFront();
      console.log('Successfully set window bounds to normal (100, 100, 1200, 800)');
    }
    await browser.close();
  } catch (e) {
    console.error('Error:', e);
  }
})();
