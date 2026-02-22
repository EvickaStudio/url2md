/**
 * stealth.js – anti-bot-detection toolkit for Playwright.
 */

const PROFILES = [
  {
    ua: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36",
    viewport: { width: 1920, height: 1080 },
    locale: "en-US",
    tz: "America/New_York",
    platform: "Win32",
    mobile: false,
  },
  {
    ua: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36",
    viewport: { width: 1440, height: 900 },
    locale: "en-US",
    tz: "America/Los_Angeles",
    platform: "MacIntel",
    mobile: false,
  },
  {
    ua: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36",
    viewport: { width: 1366, height: 768 },
    locale: "en-GB",
    tz: "Europe/London",
    platform: "Win32",
    mobile: false,
  },
  {
    ua: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15",
    viewport: { width: 1680, height: 1050 },
    locale: "en-US",
    tz: "America/Chicago",
    platform: "MacIntel",
    mobile: false,
  },
  {
    ua: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36",
    viewport: { width: 1920, height: 1080 },
    locale: "en-US",
    tz: "America/Denver",
    platform: "Linux x86_64",
    mobile: false,
  },
  {
    ua: "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:128.0) Gecko/20100101 Firefox/128.0",
    viewport: { width: 1536, height: 864 },
    locale: "en-US",
    tz: "America/New_York",
    platform: "Win32",
    mobile: false,
  },
];

export function randomProfile() {
  return PROFILES[Math.floor(Math.random() * PROFILES.length)];
}

export const STEALTH_LAUNCH_ARGS = [
  "--disable-blink-features=AutomationControlled",
  "--disable-features=IsolateOrigins,site-per-process,AutomationControlled",
  "--disable-infobars",
  "--disable-background-networking",
  "--disable-breakpad",
  "--disable-component-update",
  "--disable-default-apps",
  "--disable-dev-shm-usage",
  "--disable-extensions",
  "--no-first-run",
  "--no-default-browser-check",
  "--disable-hang-monitor",
  "--disable-popup-blocking",
  "--disable-prompt-on-repost",
  "--disable-sync",
  "--metrics-recording-only",
  "--no-sandbox",
  "--disable-gpu",
];

export function buildInitScript(profile) {
  const p = JSON.stringify(profile.platform);
  return `
    Object.defineProperty(navigator, 'webdriver', {
      get: () => undefined,
      configurable: true,
    });

    Object.defineProperty(navigator, 'platform', {
      get: () => ${p},
    });

    Object.defineProperty(navigator, 'hardwareConcurrency', {
      get: () => ${4 + Math.floor(Math.random() * 13)},
    });

    Object.defineProperty(navigator, 'deviceMemory', {
      get: () => ${[4, 8, 16][Math.floor(Math.random() * 3)]},
    });

    Object.defineProperty(navigator, 'languages', {
      get: () => ['${profile.locale}', '${profile.locale.split("-")[0]}'],
    });

    if (!window.chrome) {
      window.chrome = {
        runtime: {
          onConnect:  { addListener() {}, removeListener() {}, hasListeners() { return false; } },
          onMessage:  { addListener() {}, removeListener() {}, hasListeners() { return false; } },
          connect()   { return {}; },
          sendMessage() {},
          id: undefined,
        },
        loadTimes() { return {}; },
        csi()       { return {}; },
      };
    }

    Object.defineProperty(navigator, 'plugins', {
      get: () => {
        const make = (n, f, d) => ({ name: n, filename: f, description: d, length: 1, item: () => null, namedItem: () => null, [Symbol.iterator]: function*(){} });
        const list = [
          make('Chrome PDF Plugin', 'internal-pdf-viewer', 'Portable Document Format'),
          make('Chrome PDF Viewer', 'mhjfbmdgcfjbbpaeojofohoefgiehjai', ''),
          make('Native Client', 'internal-nacl-plugin', ''),
        ];
        list.length = 3;
        list.item    = i => list[i];
        list.namedItem = n => list.find(p => p.name === n) || null;
        list.refresh = () => {};
        list[Symbol.iterator] = function*(){ yield* [list[0],list[1],list[2]]; };
        return list;
      },
    });

    Object.defineProperty(navigator, 'mimeTypes', {
      get: () => {
        const m = { length: 2, item: () => null, namedItem: () => null, [Symbol.iterator]: function*(){} };
        return m;
      },
    });

    if (navigator.permissions) {
      const _query = navigator.permissions.query.bind(navigator.permissions);
      navigator.permissions.query = (desc) => {
        if (desc.name === 'notifications') {
          return Promise.resolve({ state: Notification.permission, onchange: null });
        }
        return _query(desc).catch(() => ({ state: 'prompt', onchange: null }));
      };
    }

    (function patchWebGL() {
      const vendors  = ['Intel Inc.', 'Google Inc. (Intel)', 'Google Inc. (NVIDIA)'];
      const renderers = [
        'Intel Iris OpenGL Engine',
        'ANGLE (Intel, Intel(R) UHD Graphics 630, OpenGL 4.1)',
        'ANGLE (NVIDIA, NVIDIA GeForce GTX 1650, OpenGL 4.5)',
      ];
      const vi = Math.floor(Math.random() * vendors.length);
      for (const Proto of [WebGLRenderingContext, WebGL2RenderingContext]) {
        if (!Proto?.prototype) continue;
        const orig = Proto.prototype.getParameter;
        Proto.prototype.getParameter = function(param) {
          if (param === 37445) return vendors[vi];
          if (param === 37446) return renderers[vi];
          return orig.call(this, param);
        };
      }
    })();

    const _createElement = document.createElement.bind(document);
    document.createElement = function(tag, ...rest) {
      const el = _createElement(tag, ...rest);
      if (tag.toLowerCase() === 'iframe') {
        const _contentWindow = Object.getOwnPropertyDescriptor(HTMLIFrameElement.prototype, 'contentWindow');
        Object.defineProperty(el, 'contentWindow', {
          get() {
            const w = _contentWindow.get.call(this);
            if (w) {
              try { w.chrome = window.chrome; } catch {}
            }
            return w;
          },
        });
      }
      return el;
    };
  `;
}

export const DISMISS_OVERLAYS_SCRIPT = `
(function dismissOverlays() {
  const selectors = [
    '[id*="cookie"] button[class*="accept"]',
    '[id*="cookie"] button[class*="agree"]',
    '[class*="cookie"] button[class*="accept"]',
    '[class*="consent"] button[class*="accept"]',
    '[class*="consent"] button[class*="allow"]',
    'button[id*="accept"]',
    '#onetrust-accept-btn-handler',
    '.cc-btn.cc-dismiss',
    '[data-testid="cookie-policy-manage-dialog-btn-accept-all"]',
    '[aria-label="Accept cookies"]',
    '[aria-label="Accept all cookies"]',
    'button.cookie-accept',
    '#CybotCookiebotDialogBodyLevelButtonLevelOptinAllowAll',
    '[class*="overlay"] [class*="close"]',
    '[class*="modal"] [class*="close"]',
    '[class*="popup"] [class*="close"]',
    '[aria-label="Close"]',
    '[aria-label="Dismiss"]',
  ];

  for (const sel of selectors) {
    try {
      const btn = document.querySelector(sel);
      if (btn && btn.offsetParent !== null) {
        btn.click();
        return;
      }
    } catch {}
  }

  for (const el of document.querySelectorAll('[class*="cookie"],[class*="consent"],[class*="gdpr"],[id*="cookie"],[id*="consent"]')) {
    try { el.style.display = 'none'; } catch {}
  }
})();
`;
