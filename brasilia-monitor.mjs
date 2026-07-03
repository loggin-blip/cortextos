/**
 * Brasilia Oslo availability monitor + auto-booker
 * Checks June 27 21:00 for 4 guests every 15 min.
 * Books automatically if slot opens.
 */
import { chromium } from 'playwright';
import { execSync } from 'child_process';

const TARGET_DATE = '27';
const GUESTS = 4;
const DETAILS = { firstName: 'Max', lastName: 'Lien', email: 'loggin@convoai.no', phone: '+4791243224' };
const CHECK_INTERVAL_MS = 15 * 60 * 1000; // 15 min (faster now)
const CHAT_ID = '6447044389';

function tg(msg) {
  try { execSync(`cd /Users/max/cortextos && cortextos bus send-telegram ${CHAT_ID} '${msg.replace(/'/g, "'\\''")}'`); }
  catch (e) { console.error('TG fail:', e.message); }
}

async function checkAndBook() {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.setViewportSize({ width: 1280, height: 900 });
  try {
    await page.goto('https://www.sevenrooms.com/explore/brasiliaoslo/reservations/create/search/?lang=nb', {
      waitUntil: 'networkidle', timeout: 30000,
    });
    await page.waitForTimeout(2000);

    // Set 4 guests
    await page.locator('button').filter({ hasText: /Gjester|Gjest/i }).first().click();
    await page.waitForTimeout(600);
    await page.locator('li, button, [role="option"]').filter({ hasText: `${GUESTS} Gjester` }).first().click();
    await page.waitForTimeout(600);

    // Set June 27
    await page.locator('button').filter({ hasText: /Dato/i }).first().click();
    await page.waitForTimeout(800);
    await page.locator('td, [role="gridcell"], button').filter({ hasText: new RegExp(`^${TARGET_DATE}$`) }).first().click();
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
    if (body.includes('fullbooket')) {
      console.log(`[${new Date().toISOString()}] Still fully booked`);
      await browser.close();
      return false;
    }

    // Check for slot button
    const slotBtn = page.locator('[data-test="reservation-timeslot-button-21:00"]');
    const hasSlot = await slotBtn.isVisible({ timeout: 2000 }).catch(() => false);
    if (!hasSlot) {
      console.log(`[${new Date().toISOString()}] No 21:00 slot visible`);
      await browser.close();
      return false;
    }

    console.log(`[${new Date().toISOString()}] SLOT FOUND! Booking...`);
    tg('Slot ledig! Booker nå...');

    // Close any auto-opened modal first
    const modal = page.locator('[data-test="reservation-availability-modal"]');
    if (await modal.isVisible({ timeout: 1000 }).catch(() => false)) {
      await page.keyboard.press('Escape');
      await page.waitForTimeout(500);
    }

    // Click the slot
    await slotBtn.scrollIntoViewIfNeeded();
    await slotBtn.click({ force: true });
    await page.waitForTimeout(2000);

    // Handle section modal (INSIDE/OUTSIDE)
    const sectionModal = page.locator('[data-test="reservation-availability-modal"]');
    if (await sectionModal.isVisible({ timeout: 3000 }).catch(() => false)) {
      // Click first "Velg" button in modal
      const velg = sectionModal.locator('button').filter({ hasText: /Velg|Select/i }).first();
      if (await velg.isVisible({ timeout: 2000 }).catch(() => false)) {
        await velg.click();
        await page.waitForTimeout(1500);
      } else {
        // Click anywhere in modal to proceed
        await sectionModal.click();
        await page.waitForTimeout(1000);
      }
    }

    // Fill booking form
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
      }
    }

    if (filled === 0) {
      tg('Slot klikket men form ikke lastet — slot kan være borte igjen. Prøver neste gang.');
      await browser.close();
      return false;
    }

    // Submit
    const submitSels = ['button[type="submit"]', 'button:has-text("Bekreft")', 'button:has-text("Reserver")', 'button:has-text("Book")', 'button:has-text("Fullfør")', 'button:has-text("Confirm")'];
    for (const sel of submitSels) {
      const btn = page.locator(sel).first();
      if (await btn.isVisible({ timeout: 1500 }).catch(() => false)) {
        await btn.click();
        console.log('Submitted via:', sel);
        break;
      }
    }

    await page.waitForTimeout(3000);
    const result = await page.locator('body').innerText().catch(() => '');
    const ok = result.toLowerCase().match(/bekreftet|confirmed|reservation|kvittering|receipt/);
    if (ok) {
      tg(`BOOKET! Brasilia Oslo 27 juni 21:00, 4 gjester. Bekreftelse → ${DETAILS.email}`);
      await browser.close();
      return true;
    } else {
      tg(`Innsendt — sjekk ${DETAILS.email} for bekreftelse.`);
      await browser.close();
      return true;
    }
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Error:`, err.message.split('\n')[0]);
    await browser.close().catch(() => {});
    return false;
  }
}

async function main() {
  console.log('Monitor started — checking every 15 min');
  const booked = await checkAndBook();
  if (booked) { process.exit(0); }

  const interval = setInterval(async () => {
    const now = new Date();
    if (now.getUTCDate() > 27 || (now.getUTCDate() === 27 && now.getUTCHours() >= 22)) {
      tg('Brasilia-overvåking stoppet — 27 juni er passert.');
      clearInterval(interval);
      process.exit(0);
    }
    const done = await checkAndBook();
    if (done) { clearInterval(interval); process.exit(0); }
  }, CHECK_INTERVAL_MS);
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
