/**
 * Emergency fix: slot opened, modal intercepted click.
 * The INSIDE modal auto-opens — click "Velg" inside it directly.
 */
import { chromium } from 'playwright';
import { execSync } from 'child_process';

const DETAILS = { firstName: 'Max', lastName: 'Lien', email: 'loggin@convoai.no', phone: '+4791243224' };
const CHAT_ID = '6447044389';

function tg(msg) {
  try { execSync(`cd /Users/max/cortextos && cortextos bus send-telegram ${CHAT_ID} '${msg.replace(/'/g, "'\\''")}'`); }
  catch (e) { console.error('TG fail:', e.message); }
}

(async () => {
  const browser = await chromium.launch({ headless: false, slowMo: 300 });
  const page = await browser.newPage();
  await page.setViewportSize({ width: 1280, height: 900 });

  console.log('Loading...');
  await page.goto('https://www.sevenrooms.com/explore/brasiliaoslo/reservations/create/search/?lang=nb', {
    waitUntil: 'networkidle', timeout: 30000,
  });
  await page.waitForTimeout(2000);

  // Set 4 guests
  await page.locator('button').filter({ hasText: /Gjester|Gjest/i }).first().click();
  await page.waitForTimeout(600);
  await page.locator('li, button, [role="option"]').filter({ hasText: '4 Gjester' }).first().click();
  await page.waitForTimeout(600);

  // Set June 27
  await page.locator('button').filter({ hasText: /Dato/i }).first().click();
  await page.waitForTimeout(800);
  await page.locator('td, [role="gridcell"], button').filter({ hasText: /^27$/ }).first().click();
  await page.waitForTimeout(800);

  // Set 21:00
  const tidBtn = page.locator('button').filter({ hasText: /Tid/i }).first();
  if (await tidBtn.isVisible({ timeout: 1000 }).catch(() => false)) {
    await tidBtn.click();
    await page.waitForTimeout(500);
    await page.locator('li, button, [role="option"]').filter({ hasText: '21:00' }).first().click();
    await page.waitForTimeout(600);
  }

  await page.waitForTimeout(2000);
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await page.waitForTimeout(1000);

  const body = await page.locator('body').innerText().catch(() => '');
  console.log('Page state:', body.slice(0, 300));
  await page.screenshot({ path: '/tmp/fix-step1.png', fullPage: true });

  if (body.includes('fullbooket')) {
    console.log('Still fully booked');
    tg('Brasilia 27 juni: slot er borte igjen — fullbooket. Fortsetter å overvåke...');
    await browser.close();
    process.exit(1);
  }

  // Check if modal is already open (INSIDE auto-opens)
  const modal = page.locator('[data-test="reservation-availability-modal"]');
  const modalOpen = await modal.isVisible({ timeout: 2000 }).catch(() => false);
  console.log('Modal already open:', modalOpen);

  if (modalOpen) {
    console.log('Modal open — looking for Velg button inside it');
    const velgBtn = modal.locator('button').filter({ hasText: /Velg|Select|Book/i }).first();
    if (await velgBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
      await velgBtn.click();
      console.log('Clicked Velg in modal');
    } else {
      // Try pressing Escape to close modal, then click slot
      await page.keyboard.press('Escape');
      await page.waitForTimeout(500);
    }
  }

  // Look for slot button by data-test attribute
  const slotBtn = page.locator('[data-test="reservation-timeslot-button-21:00"]');
  if (await slotBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
    // Make sure no modal is blocking
    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);
    await slotBtn.click();
    console.log('Clicked slot button');
  } else {
    // Try scrolling into view and clicking any 21:xx button
    const anySlot = page.locator('button').filter({ hasText: /^21:00$/ }).first();
    if (await anySlot.isVisible({ timeout: 2000 }).catch(() => false)) {
      await anySlot.scrollIntoViewIfNeeded();
      await anySlot.click({ force: true });
      console.log('Force-clicked 21:00');
    } else {
      console.log('No 21:xx slot button found');
      tg('Slot ikke synlig lenger — fullbooket igjen.');
      await browser.close();
      process.exit(1);
    }
  }

  await page.waitForTimeout(2000);
  await page.screenshot({ path: '/tmp/fix-step2.png', fullPage: true });

  // Handle section modal (INSIDE/OUTSIDE picker)
  const sectionModal = page.locator('[data-test="reservation-availability-modal"]');
  if (await sectionModal.isVisible({ timeout: 3000 }).catch(() => false)) {
    console.log('Section modal appeared');
    const sectionBody = await sectionModal.innerText().catch(() => '');
    console.log('Modal content:', sectionBody.slice(0, 300));

    // Click Velg/Select inside modal
    const velg = sectionModal.locator('button').filter({ hasText: /Velg|Select/i }).first();
    if (await velg.isVisible({ timeout: 2000 }).catch(() => false)) {
      await velg.click();
      console.log('Selected section');
      await page.waitForTimeout(1500);
    }
  }

  await page.screenshot({ path: '/tmp/fix-step3.png', fullPage: true });
  const step3Body = await page.locator('body').innerText().catch(() => '');
  console.log('After section select:', step3Body.slice(0, 500));

  // Fill the booking form
  const fieldMap = [
    ['input[name*="first" i], input[placeholder*="Fornavn" i], input[placeholder*="First" i]', DETAILS.firstName],
    ['input[name*="last" i], input[placeholder*="Etternavn" i], input[placeholder*="Last" i]', DETAILS.lastName],
    ['input[type="email"], input[name*="email" i]', DETAILS.email],
    ['input[type="tel"], input[name*="phone" i], input[placeholder*="telefon" i]', DETAILS.phone],
  ];

  let filled = 0;
  for (const [sel, val] of fieldMap) {
    const el = page.locator(sel).first();
    if (await el.isVisible({ timeout: 3000 }).catch(() => false)) {
      await el.fill(val);
      filled++;
      console.log('Filled:', sel.split(',')[0].trim(), '=', val);
    }
  }
  console.log(`Filled ${filled} fields`);
  await page.screenshot({ path: '/tmp/fix-step4-form.png', fullPage: true });

  if (filled > 0) {
    // Submit
    const submitSelectors = [
      'button[type="submit"]',
      'button:has-text("Bekreft")',
      'button:has-text("Reserver")',
      'button:has-text("Book")',
      'button:has-text("Fullfør")',
      'button:has-text("Confirm")',
      'button:has-text("Complete")',
    ];
    let submitted = false;
    for (const sel of submitSelectors) {
      const btn = page.locator(sel).first();
      if (await btn.isVisible({ timeout: 1500 }).catch(() => false)) {
        await btn.click();
        submitted = true;
        console.log('Submitted via:', sel);
        break;
      }
    }
    await page.waitForTimeout(3000);
    await page.screenshot({ path: '/tmp/fix-step5-result.png', fullPage: true });
    const result = await page.locator('body').innerText().catch(() => '');
    console.log('Result:', result.slice(0, 800));

    const ok = result.toLowerCase().match(/bekreftet|confirmed|reservation|bestilling|kvittering|receipt/);
    if (ok) {
      tg(`BOOKET! Brasilia Oslo 27 juni 21:00, 4 gjester. Bekreftelse → ${DETAILS.email}`);
    } else if (submitted) {
      tg(`Sendt inn — sjekk ${DETAILS.email} for bekreftelse. Skjermbilde lagret.`);
    } else {
      tg(`Form fylt men ingen submit-knapp funnet. Sjekk /tmp/fix-step4-form.png`);
    }
  } else {
    console.log('No form fields found yet');
    tg(`Slot klikket men form ikke lastet. Sjekk /tmp/fix-step3.png`);
  }

  await page.waitForTimeout(5000);
  await browser.close();
})();
