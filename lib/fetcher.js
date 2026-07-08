const axios = require('axios');
const { detectBotBlock } = require('./blockDetector');

const DEFAULT_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

// Vài User-Agent desktop phổ biến thật để xoay vòng — MỖI CUỐN SÁCH (1 job) dùng cố định
// 1 UA trong suốt quá trình crawl (không đổi giữa các request), giống hành vi 1 trình duyệt
// thật của 1 người dùng, thay vì đổi UA liên tục giữa các request (dễ trông đáng ngờ hơn).
const UA_POOL = [
  DEFAULT_UA,
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:126.0) Gecko/20100101 Firefox/126.0',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36 Edg/124.0.0.0',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
];

function pickRandomUA() {
  return UA_POOL[Math.floor(Math.random() * UA_POOL.length)];
}

/** Lỗi khi phát hiện trang chặn bot toàn trang — không nên retry, nên dừng hẳn ngay. */
class BlockedError extends Error {
  constructor(message, info = {}) {
    super(message);
    this.name = 'BlockedError';
    this.blocked = true;
    this.info = info;
  }
}

let browserPromise = null;

/**
 * Trình duyệt chỉ được dùng khi static fetch thất bại/không đủ (fallback) — đúng lúc đó
 * cũng là lúc nhiều khả năng site có chống bot, nên bật sẵn plugin "stealth" (vá các dấu
 * hiệu lộ liễu của headless Chromium: navigator.webdriver, chrome runtime, plugin list...).
 * Không bật ở static mode vì static không dùng browser, không cần.
 *
 * Có kiểm tra `isConnected()` trước khi tái sử dụng: nếu trình duyệt dùng chung đã crash
 * (vd hết RAM giữa 1 job chạy hàng nghìn chương nhiều giờ liền) thì browserPromise cũ vẫn
 * "resolve" ra 1 object Browser đã chết -> mọi lần fetch browser sau đó sẽ lỗi mãi mãi cho
 * tới khi restart cả server. Giờ tự phát hiện và khởi động lại trình duyệt mới khi cần.
 */
async function getBrowser() {
  if (browserPromise) {
    try {
      const existing = await browserPromise;
      if (existing.isConnected()) return browserPromise;
      console.warn('[fetcher] Trình duyệt dùng chung đã mất kết nối (crash?) -> khởi động lại');
    } catch (err) {
      console.warn(`[fetcher] Trình duyệt dùng chung lỗi (${err.message}) -> khởi động lại`);
    }
    browserPromise = null;
  }

  {
    let chromium;
    try {
      chromium = require('playwright-extra').chromium;
      const stealth = require('puppeteer-extra-plugin-stealth')();
      chromium.use(stealth);
      console.log('[fetcher] Dùng playwright-extra + stealth cho browser fallback');
    } catch {
      chromium = require('playwright').chromium;
      console.log('[fetcher] playwright-extra/stealth chưa cài -> dùng playwright thường');
    }
    try {
      browserPromise = chromium.launch({ headless: true });
      await browserPromise;
    } catch (err) {
      console.warn(`[fetcher] Launch qua playwright-extra lỗi (${err.message}) -> thử lại bằng playwright thường`);
      browserPromise = require('playwright').chromium.launch({ headless: true });
    }
  }
  return browserPromise;
}

async function fetchStatic(url, { timeout = 15000, cookie, userAgent } = {}) {
  const headers = {
    'User-Agent': userAgent || DEFAULT_UA,
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'vi-VN,vi;q=0.9,en;q=0.8',
  };
  if (cookie) headers.Cookie = cookie;
  console.log(`[fetcher] static fetch: ${url}`);
  const res = await axios.get(url, { headers, timeout, responseType: 'text', maxRedirects: 5 });
  console.log(`[fetcher] static status=${res.status}, length=${res.data.length}`);
  return res.data;
}

async function fetchWithBrowser(url, { timeout = 30000, cookie, waitFor, userAgent } = {}) {
  console.log(`[fetcher] browser fetch (stealth nếu có): ${url}`);
  const browser = await getBrowser();
  const context = await browser.newContext({ userAgent: userAgent || DEFAULT_UA, locale: 'vi-VN' });
  if (cookie) {
    const cookies = cookie
      .split(';')
      .map((pair) => {
        const [name, ...rest] = pair.trim().split('=');
        return { name, value: rest.join('='), url };
      })
      .filter((c) => c.name);
    if (cookies.length) await context.addCookies(cookies);
  }
  const page = await context.newPage();
  try {
    await page.goto(url, { waitUntil: 'networkidle', timeout });
    if (waitFor) {
      const found = await page.waitForSelector(waitFor, { timeout: 12000 }).catch(() => null);
      if (found) {
        await page.waitForTimeout(500);
      } else {
        console.warn(`[fetcher] không thấy waitFor selector "${waitFor}" sau 12s, vẫn chụp HTML hiện có`);
      }
    }
    const html = await page.content();
    console.log(`[fetcher] browser OK, length=${html.length}`);
    return html;
  } finally {
    await page.close();
    await context.close();
  }
}

function checkBotBlockOrThrow(html, url) {
  const block = detectBotBlock(html);
  if (block) {
    throw new BlockedError(
      `Phát hiện trang chặn bot tại ${url} (dấu hiệu khớp: /${block.matched}/)`,
      { ...block, url }
    );
  }
}

/**
 * Lấy HTML của một URL.
 * mode: 'static' | 'browser' | 'auto'
 * minTextLength: ngưỡng độ dài chữ tối thiểu để coi bản tĩnh là "đủ dùng" khi có contentSelector
 *   (mặc định 20; truyền 0 khi contentSelector là danh sách link ngắn như link chương mục lục).
 */
async function fetchPage(url, { mode = 'static', contentSelector, cookie, waitFor, minTextLength = 20, userAgent } = {}) {
  if (mode === 'browser') {
    const html = await fetchWithBrowser(url, { cookie, waitFor: waitFor || contentSelector, userAgent });
    checkBotBlockOrThrow(html, url);
    return { html, usedBrowser: true };
  }

  if (mode === 'static') {
    const html = await fetchStatic(url, { cookie, userAgent });
    checkBotBlockOrThrow(html, url);
    return { html, usedBrowser: false };
  }

  // ---- mode === 'auto' ----
  let staticHtml = null;
  let staticError = null;
  try {
    staticHtml = await fetchStatic(url, { cookie, userAgent });
    checkBotBlockOrThrow(staticHtml, url); // static bị chặn -> thử browser (Cloudflare hay để static qua browser mới pass)
  } catch (err) {
    if (err instanceof BlockedError) {
      console.warn(`[fetcher] static bị chặn: ${err.message} -> thử browser`);
    } else {
      staticError = err;
      console.warn(`[fetcher] static lỗi: ${err.message}`);
    }
    staticHtml = null;
  }

  if (staticHtml !== null) {
    if (!contentSelector) {
      return { html: staticHtml, usedBrowser: false };
    }
    const cheerio = require('cheerio');
    const $ = cheerio.load(staticHtml);
    const found = $(contentSelector).first();
    const ok = found.length && found.text().trim().length >= minTextLength;
    if (ok) {
      return { html: staticHtml, usedBrowser: false };
    }
    console.log('[fetcher] selector không khớp/không đủ chữ trên bản tĩnh -> thử browser (1 lần, có stealth)');
  }

  const html = await fetchWithBrowser(url, { cookie, waitFor: waitFor || contentSelector, userAgent });
  checkBotBlockOrThrow(html, url); // vẫn bị chặn cả sau khi dùng browser+stealth -> báo rõ, không cố thêm nữa
  return { html, usedBrowser: true };
}

async function closeBrowser() {
  if (browserPromise) {
    const browser = await browserPromise;
    await browser.close();
    browserPromise = null;
  }
}

// Xuất getBrowser để xpathHelper.js dùng CHUNG 1 instance browser thay vì tự launch
// riêng 1 Chromium thứ hai (trước đây mỗi module launch browser độc lập -> chạy XPath
// "next" selector cùng lúc với fetch browser-mode sẽ mở 2 tiến trình Chromium song song,
// tốn gấp đôi RAM, và closeBrowser() ở server.js chỉ đóng 1 trong 2 -> tiến trình còn lại
// bị leak khi tắt app).
module.exports = { fetchPage, closeBrowser, getBrowser, BlockedError, pickRandomUA };