const cheerio = require('cheerio');
const { fetchPage, BlockedError, pickRandomUA } = require('./fetcher');
const { detectPaywall } = require('./blockDetector');
const { resolveFirstMatch } = require('./xpathHelper');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Tạo 1 "cổng" giãn cách request DÙNG CHUNG cho nhiều worker chạy song song (chế độ mục
 * lục / concurrency > 1). TRƯỚC ĐÂY: mỗi worker tự `await sleep(requestDelayMs)` độc lập
 * -> khi có N worker chạy song song, cả N request đầu tiên (và mỗi đợt sau đó) vẫn bắn ra
 * gần như CÙNG LÚC (chỉ trễ hơn so với lúc trước, chứ không hề rải đều theo thời gian thật) ->
 * site vẫn thấy 1 chùm N request dồn dập -> dễ bị chặn tạm thời (rate-limit) y như không có
 * giãn cách. GIỜ: dùng 1 hàng đợi promise dùng chung để đảm bảo THỜI ĐIỂM BẮT ĐẦU của các
 * request kế tiếp nhau (dù đến từ worker nào) cách nhau ít nhất `delayMs`, giống hệt hiệu ứng
 * giãn cách tuần tự dù đang chạy nhiều worker cùng lúc.
 */
function createRequestGate(delayMs) {
  let queueTail = Promise.resolve();
  let nextAllowedAt = 0;
  return function gate() {
    const turn = queueTail.then(async () => {
      const wait = Math.max(0, nextAllowedAt - Date.now());
      if (wait > 0) await sleep(wait);
      nextAllowedAt = Date.now() + delayMs;
    });
    queueTail = turn;
    return turn;
  };
}

function resolveUrl(base, href) {
  if (!href) return null;
  try {
    return new URL(href, base).toString();
  } catch {
    return null;
  }
}

/** Lỗi "tạm dừng" — khác lỗi thường: tiến độ đã lưu vẫn giữ nguyên, có thể resume sau. */
class PausedError extends Error {
  constructor(message, info = {}) {
    super(message);
    this.name = 'PausedError';
    this.paused = true;
    this.info = info;
  }
}

function cleanChapterHtml($, contentEl, { removeSelectors = [] } = {}) {
  const el = contentEl.clone();
  el.find('script').remove();
  el.find('style').remove();
  el.removeAttr('style').removeAttr('hidden');
  el.find('*').removeAttr('style').removeAttr('hidden');

  let templatePass = 0;
  while (el.find('template').length > 0 && templatePass < 5) {
    el.find('template').each((_, tpl) => {
      const $tpl = $(tpl);
      $tpl.replaceWith($tpl.html() || '');
    });
    templatePass++;
  }

  removeSelectors.forEach((sel) => {
    if (sel) el.find(sel).remove();
  });

  el.removeAttr('class');
  el.find('*').removeAttr('class');

  el.find('p').each((_, p) => {
    const $p = $(p);
    const hasImg = $p.find('img').length > 0;
    const hasText = $p.text().replace(/\u00a0/g, ' ').trim().length > 0;
    if (!hasImg && !hasText) $p.remove();
  });

  return el.html() || '';
}

function isNextDisabled($, el) {
  if (!el || el.length === 0) return true;
  if (el.attr('disabled') !== undefined) return true;
  const aria = (el.attr('aria-disabled') || '').toLowerCase();
  if (aria === 'true') return true;
  const cls = (el.attr('class') || '').toLowerCase();
  if (/\bdisabled\b/.test(cls)) return true;
  if (el.is('a') && !el.attr('href')) return true;
  return false;
}

const RETRY_DELAYS_MS = [2000, 5000, 12000];

/** Retry khi lỗi mạng/HTTP bình thường — KHÔNG retry khi bị BlockedError (bot-block toàn
 * trang), vì cố lại chỉ tốn thời gian và có nguy cơ bị chặn nặng hơn (rate-limit/ban IP). */
async function fetchWithRetry(url, opts, onRetry) {
  let lastErr;
  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
    try {
      return await fetchPage(url, opts);
    } catch (err) {
      if (err instanceof BlockedError) throw err;
      lastErr = err;
      if (attempt < RETRY_DELAYS_MS.length) {
        const delay = RETRY_DELAYS_MS[attempt];
        if (onRetry) onRetry(attempt + 1, RETRY_DELAYS_MS.length, delay, err);
        await new Promise((r) => setTimeout(r, delay));
      }
    }
  }
  throw lastErr;
}

/** Giống fetchWithRetry, nhưng sau khi tải xong HTML còn kiểm tra luôn contentSelector có
 * khớp không. TRƯỚC ĐÂY: "không tìm thấy selector" bị coi là lỗi vĩnh viễn -> Tạm dừng ngay
 * lần đầu tiên, không hề retry (khác với lỗi mạng). Điều đó khiến job dừng oan khi chỉ là
 * trục trặc thoáng qua (site trả về trang lỗi/placeholder tạm thời, hoặc trang JS chưa kịp
 * render xong). GIỜ: nếu selector không khớp cũng được coi như 1 lần thử lỗi -> tải lại
 * trang theo đúng lịch retry 2s/5s/12s như lỗi mạng, chỉ thật sự "Tạm dừng" sau khi đã thử
 * đủ 4 lần (1 lần đầu + 3 lần retry) mà vẫn không thấy. */
async function fetchChapterHtmlWithRetry(url, opts, onRetry) {
  const { contentSelector } = opts;
  let lastErr;
  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
    try {
      const { html } = await fetchPage(url, opts);
      if (contentSelector) {
        const $check = cheerio.load(html);
        if ($check(contentSelector).first().length === 0) {
          throw new Error(`Không tìm thấy nội dung với selector "${contentSelector}"`);
        }
      }
      return html;
    } catch (err) {
      if (err instanceof BlockedError) throw err;
      lastErr = err;
      if (attempt < RETRY_DELAYS_MS.length) {
        const delay = RETRY_DELAYS_MS[attempt];
        if (onRetry) onRetry(attempt + 1, RETRY_DELAYS_MS.length, delay, err);
        await new Promise((r) => setTimeout(r, delay));
      }
    }
  }
  throw lastErr;
}

/** Chạy `worker(item, index)` cho toàn bộ `items`, tối đa `limit` việc cùng lúc. */
async function runWithConcurrency(items, limit, worker) {
  let cursor = 0;
  async function runner() {
    while (cursor < items.length) {
      const i = cursor++;
      await worker(items[i], i);
    }
  }
  const runners = Array.from({ length: Math.min(limit, items.length) }, runner);
  await Promise.all(runners);
}

/**
 * Xử lý nội dung 1 chương đã tải: kiểm tra paywall (bot-block đã được fetchPage chặn từ
 * trước, không tới đây nữa), trích nội dung sạch.
 * Trả về { skipped: true } nếu là paywall, hoặc { title, data } nếu bình thường.
 */
function processChapterHtml($, currentUrl, { contentSelector, titleSelector, removeSelectors, chapterLabel }) {
  const contentEl = $(contentSelector).first();
  if (!contentEl || contentEl.length === 0) {
    throw new PausedError(
      `Không tìm thấy nội dung với selector "${contentSelector}" tại ${currentUrl} (tiến độ trước đó vẫn được giữ)`,
      { failedUrl: currentUrl }
    );
  }

  const contentText = contentEl.text();
  const paywall = detectPaywall(contentText);
  if (paywall) {
    console.warn(`[crawler] Bỏ qua ${chapterLabel} (nghi yêu cầu VIP/đăng nhập, dấu hiệu: /${paywall.matched}/) tại ${currentUrl}`);
    return { skipped: true, reason: 'paywall' };
  }

  const title = (titleSelector && $(titleSelector).first().text().trim()) || chapterLabel;
  const data = cleanChapterHtml($, contentEl, { removeSelectors });
  return { title, data };
}

/** Kiểu 1 (mặc định): lần theo nút "chương kế" tới khi disable. */
async function crawlByNextLink(config, onProgress, persistence = {}) {
  const {
    startUrl,
    titleSelector,
    contentSelector = 'body',
    removeSelectors = [],
    nextPageSelector,
    nextPageAttr = 'href',
    lastPageSelector,
    fetchMode = 'auto',
    cookie,
    maxChapters = 20000,
    requestDelayMs = 0,
  } = config;

  const userAgent = config.userAgent || pickRandomUA(); // cố định 1 UA cho suốt cuốn sách này

  const visited = persistence.visited || new Set();
  let currentUrl = persistence.resumeUrl || startUrl;
  let chapterCount = persistence.startCount || 0;
  let skippedCount = persistence.startSkipped || 0;
  let isFirst = true;

  while (currentUrl && chapterCount < maxChapters) {
    if (persistence.shouldStop && persistence.shouldStop()) {
      throw new PausedError(`Đã dừng theo yêu cầu người dùng ở chương ${chapterCount} (tiến độ đã được lưu)`, {
        cancelled: true,
        chapterCount,
      });
    }
    if (visited.has(currentUrl)) {
      console.log(`[crawler] Dừng: URL đã crawl trước đó (nghi lặp vòng do selector next bắt nhầm) -> ${currentUrl}`);
      break;
    }
    visited.add(currentUrl);

    if (requestDelayMs > 0 && !isFirst) await sleep(requestDelayMs);
    isFirst = false;

    let html;
    try {
      html = await fetchChapterHtmlWithRetry(
        currentUrl,
        { mode: fetchMode, contentSelector, cookie, userAgent },
        (attempt, maxAttempt, delay, err) => {
          console.warn(`[crawler] Lỗi tải "${currentUrl}" (lần ${attempt}/${maxAttempt}): ${err.message} -> thử lại sau ${delay}ms`);
        }
      );
    } catch (err) {
      if (err instanceof BlockedError) throw err; // bot-block toàn trang -> dừng hẳn, không phải "tạm dừng do mạng"
      throw new PausedError(
        `Dừng ở chương ${chapterCount + 1} sau ${RETRY_DELAYS_MS.length + 1} lần thử: ${err.message} (URL: ${currentUrl})`,
        { failedUrl: currentUrl, chapterCount }
      );
    }

    const $ = cheerio.load(html);
    const result = processChapterHtml($, currentUrl, {
      contentSelector,
      titleSelector,
      removeSelectors,
      chapterLabel: `Chương ${chapterCount + 1}`,
    });

    if (result.skipped) {
      skippedCount++;
      if (persistence.onSkipped) await persistence.onSkipped(skippedCount, currentUrl);
    } else {
      chapterCount++;
      const chapter = { title: result.title, data: result.data, url: currentUrl };
      if (persistence.onChapter) await persistence.onChapter(chapterCount, chapter);
      if (onProgress) onProgress({ index: chapterCount, title: result.title, url: currentUrl, skipped: skippedCount });
    }

    if (lastPageSelector && $(lastPageSelector).length > 0) {
      console.log(`[crawler] Dừng: khớp lastPageSelector "${lastPageSelector}"`);
      break;
    }

    const nextEl = nextPageSelector ? await resolveFirstMatch($, html, currentUrl, nextPageSelector) : null;
    if (isNextDisabled($, nextEl)) {
      const info =
        nextEl && nextEl.length
          ? `tồn tại nhưng bị coi là disabled (href="${nextEl.attr('href')}", disabled=${nextEl.attr(
              'disabled'
            )}, aria-disabled="${nextEl.attr('aria-disabled')}", class="${nextEl.attr('class')}")`
          : `KHÔNG tìm thấy phần tử khớp selector "${nextPageSelector}"`;
      console.log(`[crawler] Dừng ở "${currentUrl}" — nút next ${info}`);
      break;
    }

    const nextHref = nextEl.attr(nextPageAttr);
    currentUrl = resolveUrl(currentUrl, nextHref);
    if (persistence.onNextUrl) await persistence.onNextUrl(currentUrl);
  }

  return { chapterCount, skippedCount };
}

/**
 * Thu thập toàn bộ URL chương từ (các) trang mục lục, đi qua phân trang riêng của mục lục
 * nếu có (tocNextPageSelector). Xuất riêng để dùng lại cho cả crawl thật lẫn nút "Test mục lục".
 * Đồng thời trích (tuỳ chọn) tên sách/tác giả/bìa NGAY TỪ TRANG MỤC LỤC GỐC (chỉ đọc ở trang
 * đầu tiên — các trang phân trang tiếp theo của mục lục thường không có lại info này).
 */
async function collectChapterLinksFromToc(config, onLog) {
  const {
    tocUrl,
    chapterLinkSelector,
    chapterLinkAttr = 'href',
    tocNextPageSelector,
    bookTitleSelector,
    authorSelector,
    coverSelector,
    coverAttr = 'src',
    fetchMode = 'auto',
    cookie,
    userAgent,
    maxTocPages = 500,
  } = config;

  const links = [];
  const seenLinks = new Set(); // lọc trùng link chương — phòng trường hợp phân trang mục lục
  // bị lấn nhau (vd trang 2 vô tình liệt kê lại vài link đã có ở trang 1), tránh sinh chương
  // trùng lặp hoặc lệch index khi đóng epub.
  const metadata = {};
  const seenTocUrls = new Set();
  let currentTocUrl = tocUrl;
  let pageCount = 0;

  while (currentTocUrl && pageCount < maxTocPages) {
    if (seenTocUrls.has(currentTocUrl)) break;
    seenTocUrls.add(currentTocUrl);
    pageCount++;

    if (onLog) onLog(`Đọc trang mục lục #${pageCount}: ${currentTocUrl}`);
    const { html } = await fetchWithRetry(
      currentTocUrl,
      { mode: fetchMode, contentSelector: chapterLinkSelector, minTextLength: 0, cookie, userAgent },
      (attempt, maxAttempt, delay, err) =>
        console.warn(`[crawler] Lỗi đọc mục lục (lần ${attempt}/${maxAttempt}): ${err.message} -> thử lại sau ${delay}ms`)
    );
    const $ = cheerio.load(html);

    if (pageCount === 1) {
      if (bookTitleSelector) metadata.bookTitle = $(bookTitleSelector).first().text().trim() || undefined;
      if (authorSelector) metadata.author = $(authorSelector).first().text().trim() || undefined;
      if (coverSelector) {
        const coverEl = $(coverSelector).first();
        const coverHref = coverEl.attr(coverAttr);
        metadata.coverUrl = coverHref ? resolveUrl(currentTocUrl, coverHref) : undefined;
      }
    }

    $(chapterLinkSelector).each((_, el) => {
      const href = $(el).attr(chapterLinkAttr);
      const abs = resolveUrl(currentTocUrl, href);
      if (abs && !seenLinks.has(abs)) {
        seenLinks.add(abs);
        links.push(abs);
      }
    });

    if (!tocNextPageSelector) break;
    const nextEl = await resolveFirstMatch($, html, currentTocUrl, tocNextPageSelector);
    if (isNextDisabled($, nextEl)) break;
    currentTocUrl = resolveUrl(currentTocUrl, nextEl.attr('href'));
  }

  return { links, metadata };
}

/**
 * Kiểu 2 (tuỳ chọn): dùng danh sách link từ collectChapterLinksFromToc, fetch song song có
 * giới hạn. Biết trước tổng số chương ngay từ đầu nên progress hiện được dạng "10/2000".
 */
async function crawlByTocList(config, onProgress, persistence = {}) {
  const {
    titleSelector,
    contentSelector = 'body',
    removeSelectors = [],
    fetchMode = 'auto',
    cookie,
    concurrency = 5,
    requestDelayMs = 0,
  } = config;

  const userAgent = config.userAgent || pickRandomUA();

  const { links, metadata } = await collectChapterLinksFromToc({ ...config, userAgent }, (msg) => console.log(`[crawler] ${msg}`));
  console.log(`[crawler] Mục lục có tổng ${links.length} chương`);
  if (persistence.onTotalKnown) await persistence.onTotalKnown(links.length, metadata);

  // Giãn cách được rải đều qua 1 cổng dùng chung cho MỌI worker (xem createRequestGate) —
  // chứ không phải mỗi worker tự sleep riêng (dễ vẫn bắn dồn request dù có set delay).
  const gate = requestDelayMs > 0 ? createRequestGate(requestDelayMs) : null;

  const savedIndices = persistence.savedIndices || new Set();
  let doneCount = savedIndices.size;
  let skippedCount = persistence.startSkipped || 0;
  let stopRequested = false;
  let stopError = null;

  async function worker(url, i) {
    const index = i + 1;
    if (stopRequested || savedIndices.has(index)) return;
    if (persistence.shouldStop && persistence.shouldStop()) {
      stopRequested = true;
      stopError = new PausedError(`Đã dừng theo yêu cầu người dùng (${doneCount}/${links.length} chương)`, {
        cancelled: true,
        chapterCount: doneCount,
      });
      return;
    }

    if (gate) await gate();

    try {
      const html = await fetchChapterHtmlWithRetry(
        url,
        { mode: fetchMode, contentSelector, cookie, userAgent },
        (attempt, maxAttempt, delay, err) =>
          console.warn(`[crawler] Lỗi tải chương ${index} (lần ${attempt}/${maxAttempt}): ${err.message} -> thử lại sau ${delay}ms`)
      );
      const $ = cheerio.load(html);
      const result = processChapterHtml($, url, {
        contentSelector,
        titleSelector,
        removeSelectors,
        chapterLabel: `Chương ${index}`,
      });

      if (result.skipped) {
        skippedCount++;
        if (persistence.onSkipped) await persistence.onSkipped(skippedCount, url);
        return;
      }

      if (persistence.onChapter) await persistence.onChapter(index, { title: result.title, data: result.data, url });
      doneCount++;
      if (onProgress) onProgress({ index: doneCount, title: result.title, url, total: links.length, skipped: skippedCount });
    } catch (err) {
      if (!stopRequested) {
        stopRequested = true;
        stopError = err; // giữ nguyên loại lỗi thật (BlockedError hoặc lỗi mạng) để server.js phân biệt đúng
      }
    }
  }

  await runWithConcurrency(links, concurrency, worker);

  if (stopError) {
    if (stopError instanceof BlockedError || stopError instanceof PausedError) throw stopError;
    throw new PausedError(`Dừng crawl (${doneCount}/${links.length} chương) do lỗi: ${stopError.message}`, {
      chapterCount: doneCount,
    });
  }

  return { chapterCount: doneCount, skippedCount, total: links.length, metadata };
}

/** Tự nhận diện chế độ: có URL mục lục + selector link chương -> dùng mục lục (song song),
 * không thì mặc định theo nút "chương kế" (không cần cờ mode thủ công). */
function shouldUseTocMode(config) {
  return !!(config.tocUrl && config.chapterLinkSelector);
}

async function crawlBook(config, onProgress, persistence) {
  if (shouldUseTocMode(config)) {
    return crawlByTocList(config, onProgress, persistence);
  }
  return crawlByNextLink(config, onProgress, persistence);
}

module.exports = {
  crawlBook,
  crawlByNextLink,
  crawlByTocList,
  collectChapterLinksFromToc,
  shouldUseTocMode,
  PausedError,
  isNextDisabled,
};
