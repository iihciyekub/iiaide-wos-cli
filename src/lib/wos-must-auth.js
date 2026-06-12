const { chromium } = require("playwright");

const DEFAULT_MUST_LOGIN_URL = "https://www.webofknowledge.com/?auth=ShibbolethIdPForm&entityID=https://idp.must.edu.mo/idp/shibboleth&target=https%3A%2F%2Fwww.webofknowledge.com%2F%3FDestApp%3DWOS&ShibFederation=ChineseFederation&DestApp=WOS";

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

async function clickFirstVisible(page, selectors) {
  for (const selector of selectors) {
    const locator = page.locator(selector).first();
    if (await locator.count()) {
      try {
        if (await locator.isVisible()) {
          await locator.click();
          return selector;
        }
      } catch (_) {
        // Keep trying the next selector.
      }
    }
  }
  return null;
}

async function fillFirstVisible(page, selectors, value) {
  for (const selector of selectors) {
    const locator = page.locator(selector).first();
    if (await locator.count()) {
      try {
        if (await locator.isVisible()) {
          await locator.fill(value);
          return selector;
        }
      } catch (_) {
        // Keep trying the next selector.
      }
    }
  }
  return null;
}

async function checkFirstVisible(page, selectors) {
  for (const selector of selectors) {
    const locator = page.locator(selector).first();
    if (await locator.count()) {
      try {
        if (await locator.isVisible()) {
          const checked = await locator.isChecked().catch(() => false);
          if (!checked) await locator.check();
          return selector;
        }
      } catch (_) {
        // Keep trying the next selector.
      }
    }
  }
  return null;
}

async function extractSidFromPage(page) {
  try {
    return await page.evaluate(() => {
      const candidates = [];
      const globalCandidates = [
        globalThis.sessionData,
        globalThis.wos?.sessionData,
        globalThis.__NEXT_DATA__,
        globalThis.__INITIAL_STATE__,
      ];

      for (const candidate of globalCandidates) {
        const sid = candidate?.BasicProperties?.SID
          || candidate?.sessionData?.BasicProperties?.SID
          || candidate?.props?.pageProps?.sessionData?.BasicProperties?.SID;
        if (sid) candidates.push(sid);
      }

      function collectFromStore(getStore) {
        let store;
        try {
          store = getStore();
        } catch (_) {
          return;
        }
        if (!store) return;
        for (let index = 0; index < store.length; index += 1) {
          const key = store.key(index);
          const raw = store.getItem(key);
          if (!raw) continue;
          try {
            const parsed = JSON.parse(raw);
            const sid = parsed?.BasicProperties?.SID || parsed?.sessionData?.BasicProperties?.SID;
            if (sid) candidates.push(sid);
          } catch (_) {
            const match = raw.match(/\bSID["':= ]+([A-Z0-9]+)/i);
            if (match) candidates.push(match[1]);
          }
        }
      }

      collectFromStore(() => globalThis.sessionStorage);
      collectFromStore(() => globalThis.localStorage);

      const scriptTexts = Array.from(document.scripts)
        .map((script) => script.textContent || "")
        .join("\n");
      const match = scriptTexts.match(/BasicProperties["']?\s*:\s*\{[\s\S]{0,800}?SID["']?\s*:\s*["']([^"']+)["']/i)
        || scriptTexts.match(/\bSID["']?\s*:\s*["']([^"']+)["']/i);
      if (match) candidates.push(match[1]);

      return [...new Set(candidates.filter(Boolean))][0] || null;
    });
  } catch (error) {
    if (/SecurityError|Execution context was destroyed|Cannot find context/i.test(error.message || "")) {
      return null;
    }
    throw error;
  }
}

async function continueIntermediatePage(page, onProgress = () => {}) {
  const currentUrl = page.url();
  const submitSelectors = unique([
    'input[name="_eventId_proceed"]',
    'input[value="Accept"]',
    'button[type="submit"]',
    'input[type="submit"]',
    'input[type="button"]',
    "#continue",
    "#submit",
    "#proceed",
    'button:has-text("Continue")',
    'button:has-text("Submit")',
    'button:has-text("Proceed")',
    'button:has-text("Accept")',
    'button:has-text("I Agree")',
  ]);

  const samlResponseCount = await page.locator('input[name="SAMLResponse"]').count().catch(() => 0);
  const relayStateCount = await page.locator('input[name="RelayState"]').count().catch(() => 0);
  const formCount = await page.locator("form").count().catch(() => 0);

  if (/idp\.must\.edu\.mo\/idp\/profile\/SAML2\/POST\/SSO/i.test(currentUrl) || samlResponseCount || relayStateCount) {
    onProgress(`progress auth: advancing intermediate page ${currentUrl}`);
    const navigationPromise = page.waitForNavigation({
      waitUntil: "domcontentloaded",
      timeout: 20000,
    }).catch(() => null);

    const clicked = await clickFirstVisible(page, submitSelectors);
    if (!clicked && formCount) {
      await page.evaluate(() => {
        const form = document.forms[0];
        if (form) form.submit();
      }).catch(() => {});
    }

    await navigationPromise;
    await page.waitForLoadState("networkidle", { timeout: 20000 }).catch(() => {});
    return true;
  }

  return false;
}

async function loginAndExtractMustSid({
  account,
  password,
  url = DEFAULT_MUST_LOGIN_URL,
  headed = false,
  timeoutMs = 120000,
  onProgress = () => {},
  chromiumImpl = chromium,
}) {
  const browser = await chromiumImpl.launch({ headless: !headed });
  const context = await browser.newContext();
  const page = await context.newPage();
  page.setDefaultTimeout(timeoutMs);

  const responseSidHints = [];
  page.on("response", async (response) => {
    try {
      const responseUrl = response.url();
      if (!/session|wos|webofscience|webofknowledge/i.test(responseUrl)) return;
      const contentType = response.headers()["content-type"] || "";
      if (!contentType.includes("application/json")) return;
      const data = await response.json();
      const sid = data?.BasicProperties?.SID || data?.sessionData?.BasicProperties?.SID;
      if (sid) responseSidHints.push(sid);
    } catch (_) {
      // Ignore unreadable responses.
    }
  });

  try {
    onProgress(`progress auth: opening ${url}`);
    await page.goto(url, { waitUntil: "domcontentloaded" });
    await page.waitForLoadState("networkidle", { timeout: Math.min(timeoutMs, 30000) }).catch(() => {});

    onProgress("progress auth: filling account");
    const usernameSelector = await fillFirstVisible(page, unique([
      'input[name="j_username"]',
      'input[name="username"]',
      'input[name="user"]',
      'input[type="email"]',
      'input[autocomplete="username"]',
      'input[id*="user" i]',
      'input[id*="email" i]',
      'input[placeholder*="user" i]',
      'input[placeholder*="email" i]',
    ]), account);
    if (!usernameSelector) throw new Error(`Could not find a visible username field. Current URL: ${page.url()}`);

    const passwordSelector = await fillFirstVisible(page, unique([
      'input[name="j_password"]',
      'input[name="password"]',
      'input[type="password"]',
      'input[autocomplete="current-password"]',
      'input[id*="pass" i]',
    ]), password);
    if (!passwordSelector) throw new Error(`Could not find a visible password field. Current URL: ${page.url()}`);

    await checkFirstVisible(page, unique([
      "#checkboxByPrivacyPolicy",
      'input[name="privacyPolicyId"]',
    ]));

    onProgress("progress auth: submitting MUST login form");
    const navigationPromise = page.waitForNavigation({
      waitUntil: "domcontentloaded",
      timeout: Math.min(timeoutMs, 45000),
    }).catch(() => null);

    const clickedSelector = await clickFirstVisible(page, unique([
      'button[type="submit"]',
      'input[type="submit"]',
      "#submitButton",
      'button:has-text("Login")',
      'button:has-text("Log in")',
      'button:has-text("Sign in")',
      'button:has-text("登入")',
      'button:has-text("登录")',
    ]));
    if (!clickedSelector) await page.keyboard.press("Enter");

    await navigationPromise;
    await page.waitForLoadState("networkidle", { timeout: Math.min(timeoutMs, 45000) }).catch(() => {});

    const deadline = Date.now() + timeoutMs;
    let sid = null;
    while (Date.now() < deadline) {
      sid = responseSidHints[0] || await extractSidFromPage(page);
      if (sid) {
        onProgress(`progress auth: SID captured on ${page.url()}`);
        break;
      }

      const advanced = await continueIntermediatePage(page, onProgress);
      if (advanced) {
        await page.waitForTimeout(2000);
        continue;
      }

      if (/webofscience|webofknowledge/i.test(page.url())) {
        onProgress(`progress auth: waiting for WOS session on ${page.url()}`);
        await page.waitForTimeout(3000);
      } else {
        await page.waitForTimeout(2000);
      }
    }

    if (!sid) throw new Error(`Login succeeded but SID was not found. Final URL: ${page.url()}`);
    return {
      sid,
      finalUrl: page.url(),
    };
  } finally {
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
  }
}

module.exports = {
  DEFAULT_MUST_LOGIN_URL,
  clickFirstVisible,
  fillFirstVisible,
  checkFirstVisible,
  continueIntermediatePage,
  extractSidFromPage,
  loginAndExtractMustSid,
};
