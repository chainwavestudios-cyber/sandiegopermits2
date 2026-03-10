import { Actor } from 'apify';
import { PlaywrightCrawler } from 'crawlee';

await Actor.init();

const input = await Actor.getInput() || {};
const { startDate = '03/01/2026', endDate = '03/10/2026' } = input;

const results = [];

const crawler = new PlaywrightCrawler({
  launchContext: {
    launchOptions: { headless: true }
  },
  requestHandlerTimeoutSecs: 300,
  requestHandler: async ({ page, log }) => {

    log.info('Navigating to San Diego PDS...');
    await page.goto(
      'https://publicservices.sandiegocounty.gov/CitizenAccess/Default.aspx',
      { waitUntil: 'networkidle' }
    );

    // Screenshot to see what's on the page
    await Actor.setValue('homepage', await page.screenshot({ fullPage: true }), { 
      contentType: 'image/png' 
    });

    // Log all links so we can find the right PDS selector
    const links = await page.$$eval('a', els =>
      els.map(el => ({ 
        text: el.innerText.trim(), 
        id: el.id, 
        href: el.href,
        class: el.className 
      })).filter(l => l.text.length > 0)
    );
    log.info('Links found on page: ' + JSON.stringify(links));

    // Try multiple selectors for PDS tab
    const pdsSelectors = [
      'a:has-text("PDS")',
      'a[href*="PDS"]',
      'a[id*="PDS"]',
      'a[title*="PDS"]',
      'li:has-text("PDS") a',
      'td:has-text("PDS") a',
    ];

    let clicked = false;
    for (const selector of pdsSelectors) {
      try {
        const el = await page.$(selector);
        if (el) {
          log.info(`Found PDS using selector: ${selector}`);
          await el.click();
          clicked = true;
          break;
        }
      } catch (e) {
        log.info(`Selector failed: ${selector}`);
      }
    }

    if (!clicked) {
      log.error('Could not find PDS link with any selector. Check homepage screenshot in key-value store.');
      return;
    }

    await page.waitForLoadState('networkidle');
    log.info('On PDS page');

    // Screenshot after clicking PDS
    await Actor.setValue('pds_page', await page.screenshot({ fullPage: true }), { 
      contentType: 'image/png' 
    });

    // Fill date range
    await page.fill('input[id*="txtSearchStartDate"]', startDate);
    await page.fill('input[id*="txtSearchEndDate"]', endDate);
    log.info(`Date range set: ${startDate} to ${endDate}`);

    // Scroll down and expand additional criteria
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.click('img[alt="Expand"]');
    log.info('Waiting 10s for additional criteria to load...');
    await page.waitForTimeout(10000);

    // Screenshot after expanding criteria
    await Actor.setValue('criteria_expanded', await page.screenshot({ fullPage: true }), { 
      contentType: 'image/png' 
    });

    // Select solar scope code
    await page.selectOption(
      'select[id*="SecondaryScopeCode1"]',
      { label: '8002 - REN - Solar Photovoltaic Roof Mount Residential - Online' }
    );
    log.info('Solar scope code selected');

    // Scroll and search
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.click('a[id*="btnSearch"]');
    await page.waitForSelector('tr.gdvPermitList_Row', { timeout: 60000 });
    log.info('Search results loaded');

    // Screenshot of results
    await Actor.setValue('results_page', await page.screenshot({ fullPage: true }), { 
      contentType: 'image/png' 
    });

    // Scrape results table
    const leads = await page.$$eval('tr.gdvPermitList_Row', rows => {
      return rows.map(row => ({
        recordId: row.cells[1]?.innerText.trim(),
        openedDate: row.cells[2]?.innerText.trim(),
        recordType: row.cells[3]?.innerText.trim(),
        projectName: row.cells[4]?.innerText.trim(),
        address: row.cells[5]?.innerText.trim(),
        status: row.cells[6]?.innerText.trim(),
        action: row.cells[7]?.innerText.trim(),
        shortNotes: row.cells[8]?.innerText.trim(),
        linkId: row.querySelector('a')?.id
      }));
    });

    log.info(`Found ${leads.length} permit records. Getting details...`);

    // Deep dive each record
    for (const lead of leads) {
      const detailPage = await page.context().newPage();
      try {
        const href = await page.getAttribute(`a[id="${lead.linkId}"]`, 'href');
        if (!href) {
          log.warning(`No href found for ${lead.recordId}, skipping detail`);
          results.push(lead);
          continue;
        }

        const fullUrl = new URL(href, page.url()).href;
        await detailPage.goto(fullUrl, { waitUntil: 'networkidle' });

        await detailPage.click('a:has-text("More Details")');
        await detailPage.waitForTimeout(2000);
        await detailPage.click('a:has-text("Application Information")');
        await detailPage.waitForSelector('div.appInfoTable', { timeout: 15000 });

        const appInfo = await detailPage.evaluate(() => {
          const getValue = (label) => {
            const spans = Array.from(document.querySelectorAll('span'));
            const target = spans.find(s => s.innerText.includes(label));
            return target
              ? target.parentElement?.nextElementSibling?.innerText.trim()
              : 'N/A';
          };
          return {
            primaryScopeCode: getValue('Primary Scope Code'),
            kwSystemSize: getValue('Rounded Kilowatts Total System Size'),
            electricalUpgrade: getValue('Electrical Service Upgrade'),
            energyStorage: getValue('Advanced Energy Storage System')
          };
        });

        results.push({ ...lead, ...appInfo });
        log.info(`✓ ${lead.recordId} — ${lead.address}`);

      } catch (err) {
        log.error(`Failed detail for ${lead.recordId}: ${err.message}`);
        results.push(lead);
      } finally {
        await detailPage.close();
      }
    }

    await Actor.pushData(results);
    log.info(`Done. ${results.length} total records saved to dataset.`);
  }
});

await crawler.run([
  'https://publicservices.sandiegocounty.gov/CitizenAccess/Default.aspx'
]);

await Actor.exit();
