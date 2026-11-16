// Optional server-side PDF. client-uptime has zero dependencies, so this only works if you
// install a headless browser yourself:  npm install playwright && npx playwright install chromium
// Without it, the report page has a "Save as PDF" button that uses the browser's print dialog
// (the report has a dedicated A4 print layout).

export async function createPdfEngine({ log = console } = {}) {
  let chromium = null;
  try {
    ({ chromium } = await import('playwright'));
  } catch {
    try { ({ chromium } = await import('playwright-core')); } catch { /* not installed */ }
  }
  if (!chromium) return { available: false, async render() { return null; } };
  return {
    available: true,
    async render(html) {
      let browser;
      try {
        browser = await chromium.launch();
        const page = await browser.newPage();
        await page.setContent(html, { waitUntil: 'load' });
        await page.emulateMedia({ media: 'print' });
        return await page.pdf({ format: 'A4', printBackground: true, preferCSSPageSize: true });
      } catch (err) {
        log.warn?.(`[pdf] ${err.message}`);
        return null;
      } finally {
        await browser?.close();
      }
    },
  };
}
