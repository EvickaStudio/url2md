import { chromium } from "playwright";
import cfg from "./config.js";
import { STEALTH_LAUNCH_ARGS, randomProfile, buildInitScript } from "./stealth.js";

let _browser = null;
let _requestCount = 0;
let _launching = null;

const LAUNCH_OPTIONS = {
  headless: true,
  args: STEALTH_LAUNCH_ARGS,
};

async function _launch() {
  const b = await chromium.launch(LAUNCH_OPTIONS);
  b.on("disconnected", () => {
    if (_browser === b) { _browser = null; _requestCount = 0; }
  });
  return b;
}

export async function getBrowser() {
  if (_browser && _requestCount >= cfg.browserMaxRequests) {
    const old = _browser;
    _browser = null;
    _requestCount = 0;
    old.close().catch(() => {});
  }

  if (_browser) {
    _requestCount++;
    return _browser;
  }

  if (!_launching) {
    _launching = _launch().then((b) => {
      _browser = b;
      _requestCount = 1;
      _launching = null;
      return b;
    }).catch((e) => {
      _launching = null;
      throw e;
    });
  }
  return _launching;
}

export async function createStealthContext(proxyUrl) {
  const browser = await getBrowser();
  const profile = randomProfile();

  const ctxOpts = {
    userAgent: profile.ua,
    viewport: profile.viewport,
    locale: profile.locale,
    timezoneId: profile.tz,
    isMobile: profile.mobile,
    hasTouch: profile.mobile,
    deviceScaleFactor: profile.mobile ? 2 : 1,
    extraHTTPHeaders: {
      "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
      "Accept-Language": `${profile.locale},${profile.locale.split("-")[0]};q=0.9`,
      "DNT": "1",
      "Upgrade-Insecure-Requests": "1",
      "Sec-CH-UA": `"Chromium";v="136", "Google Chrome";v="136", "Not.A/Brand";v="99"`,
      "Sec-CH-UA-Mobile": profile.mobile ? "?1" : "?0",
      "Sec-CH-UA-Platform": `"${profile.platform.includes("Win") ? "Windows" : profile.platform.includes("Mac") ? "macOS" : "Linux"}"`,
    },
    javaScriptEnabled: true,
    ignoreHTTPSErrors: true,
  };

  if (proxyUrl) {
    const u = new URL(proxyUrl);
    ctxOpts.proxy = {
      server: `${u.protocol}//${u.host}`,
      ...(u.username ? { username: u.username, password: u.password } : {}),
    };
  }

  const context = await browser.newContext(ctxOpts);
  await context.addInitScript({ content: buildInitScript(profile) });

  return { context, profile };
}

export async function closeBrowser() {
  if (_browser) {
    await _browser.close().catch(() => {});
    _browser = null;
    _requestCount = 0;
  }
}
