import { chromium } from 'playwright';

const DETAILS = {
  guests: 4,
  firstName: 'Max',
  lastName: 'Lien',
  email: 'loggin@convoai.no',
  phone: '+4791243224',
};

(async () => {
  const browser = await chromium.launch({ headless: false, slowMo: 200 });
  const page = await browser.newPage();
  await page.setViewportSize({ width: 1280, height: 900 });

  console.log('Loading page...');
  await page.goto('https://www.sevenrooms.com/explore/brasiliaoslo/reservations/create/search/?lang=nb', {
    waitUntil: 'networkidle', timeout: 30000,
  });
  await page.waitForTimeout(2000);

  // Set 4 guests
  const guestBtn = page.locator('button').filter({ hasText: /Gjester|Gjest/i }).first();
  await guestBtn.click();
  await page.waitForTimeout(600);
  await page.locator('li, button, [role="option"]').filter({ hasText: '4 Gjester' }).first().click();
  console.log('4 guests set');
  await page.waitForTimeout(600);

  // Set date June 27
  const dateBtn = page.locator('button').filter({ hasText: /Dato/i }).first();
  await dateBtn.click();
  await page.waitForTimeout(800);
  await page.locator('td, [role="gridcell"], button').filter({ hasText: /^27$/ }).first().click();
  console.log('Date June 27 set');
  await page.waitForTimeout(1000);

  // Set time 21:00
  const tidBtn = page.locator('button').filter({ hasText: /Tid/i }).first();
  if (await tidBtn.isVisible({ timeout: 1000 }).catch(() => false)) {
    await tidBtn.click();
    await page.waitForTimeout(600);
    await page.locator('li, button, [role="option"]').filter({ hasText: '21:00' }).first().click();
    console.log('Time 21:00 set');
    await page.waitForTimeout(600);
  }

  // Wait for results to load and scroll down
  await page.waitForTimeout(2000);
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await page.waitForTimeout(1000);
  await page.screenshot({ path: '/tmp/results-scroll-bottom.png', fullPage: true });

  // Get full page content
  const fullBody = await page.locator('body').innerText().catch(() => '');
  console.log('\n=== FULL PAGE CONTENT ===\n', fullBody);

  // Look for slot cards (usually have time + section/room name)
  const allLinks = await page.locator('a').all();
  for (const link of allLinks) {
    const text = await link.innerText().catch(() => '');
    if (text.trim()) console.log('LINK:', text.trim().slice(0, 80));
  }

  // Check if page shows "ingen tilgjengelighet" or similar
  const hasSlots = !fullBody.includes('fullbooket') && !fullBody.includes('ingen tilgjengelighet');
  console.log('\nSlots might be available:', hasSlots);

  // Try ALL Tider first (remove time filter), then scroll
  console.log('\n--- Trying "Alle Tider" (no time filter) ---');
  const tidBtn2 = page.locator('button').filter({ hasText: /Tid/i }).first();
  if (await tidBtn2.isVisible({ timeout: 1000 }).catch(() => false)) {
    await tidBtn2.click();
    await page.waitForTimeout(600);
    const alleTider = page.locator('li, button, [role="option"]').filter({ hasText: /Alle Tider/i }).first();
    if (await alleTider.isVisible({ timeout: 1000 }).catch(() => false)) {
      await alleTider.click();
      await page.waitForTimeout(800);
    }
  }
  await page.waitForTimeout(1500);
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await page.waitForTimeout(1000);
  await page.screenshot({ path: '/tmp/results-all-times.png', fullPage: true });
  const allTimesBody = await page.locator('body').innerText().catch(() => '');
  console.log('With Alle Tider:\n', allTimesBody.slice(0, 2000));

  await browser.close();
  console.log('\nDone. Screenshots at /tmp/results-*.png');
})();
