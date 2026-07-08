const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const cheerio = require('cheerio');

const { fetchPage, closeBrowser, BlockedError } = require('./lib/fetcher');
const { crawlBook, PausedError, isNextDisabled, collectChapterLinksFromToc, shouldUseTocMode } = require('./lib/crawler');
const { resolveFirstMatch, isXPath } = require('./lib/xpathHelper');
const { buildEpub } = require('./lib/epubBuilder');
const store = require('./lib/bookStore');
const providerStore = require('./lib/providerStore');

const app = express();
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const OUTPUT_DIR = path.join(__dirname, 'output');
if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });
app.use('/download', express.static(OUTPUT_DIR));

// ---- Bộ nhớ job tạm (đủ dùng cho app chạy local, 1 tiến trình) ----
const jobs = new Map();

function newJob(bookDir) {
  const id = crypto.randomUUID();
  const job = {
    id,
    bookDir,
    status: 'running', // running | done | error | paused | cancelled
    progress: { index: 0, title: null, url: null },
    error: null,
    downloadUrl: null,
    chapterCount: 0,
    createdAt: Date.now(),
    cancelRequested: false,
    bookTitle: null,
  };
  jobs.set(id, job);
  return job;
}

// Dọn job cũ khỏi bộ nhớ — CHỈ dọn job đã KẾT THÚC (done/error/paused/cancelled/blocked).
// Trước đây dọn theo tuổi (createdAt) bất kể trạng thái, nên 1 job đang "running" của
// sách rất dài (nhiều giờ, README mục 13 đã nói rõ chuyện này) có thể bị xoá khỏi map sau
// đúng 2 tiếng dù crawl NỀN vẫn đang chạy bình thường -> frontend polling /api/jobs/:id sẽ
// nhận 404 "Không tìm thấy job" và người dùng tưởng nhầm là job đã chết/lỗi, dù dữ liệu
// chương vẫn đang được lưu tiến độ bình thường dưới đĩa.
setInterval(() => {
  const cutoff = Date.now() - 2 * 60 * 60 * 1000;
  for (const [id, job] of jobs) {
    if (job.status !== 'running' && job.createdAt < cutoff) jobs.delete(id);
  }
}, 30 * 60 * 1000);

// ---- Bước 1: Test selector -> trả về nội dung ĐÃ LỌC SẠCH (không script, không ads) để preview ----
app.post('/api/preview', async (req, res) => {
  const { url, contentSelector, titleSelector, removeSelectors, fetchMode, cookie } = req.body || {};
  if (!url) return res.status(400).json({ ok: false, error: 'Thiếu url' });

  const sel = (contentSelector && contentSelector.trim()) || 'body';
  console.log(`[preview] Bắt đầu: ${url} | contentSelector="${sel}"`);
  const startedAt = Date.now();

  try {
    const { html, usedBrowser } = await fetchPage(url, {
      mode: fetchMode || 'auto',
      contentSelector: sel,
      cookie,
    });
    const $ = cheerio.load(html);
    const contentEl = $(sel).first();

    if (!contentEl.length) {
      console.log(`[preview] Không tìm thấy selector "${sel}"`);
      return res.json({ ok: false, error: `Không tìm thấy phần tử khớp selector "${sel}"` });
    }

    const clone = contentEl.clone();
    clone.find('script').remove();
    clone.find('style').remove();
    clone.removeAttr('style').removeAttr('hidden');
    clone.find('*').removeAttr('style').removeAttr('hidden');

    let templatePass = 0;
    while (clone.find('template').length > 0 && templatePass < 5) {
      clone.find('template').each((_, tpl) => {
        const $tpl = $(tpl);
        $tpl.replaceWith($tpl.html() || '');
      });
      templatePass++;
    }
    if (templatePass > 0) console.log(`[preview] Đã bóc ${templatePass} lượt thẻ <template> khỏi nội dung`);

    (removeSelectors || []).forEach((rsel) => {
      if (rsel) clone.find(rsel).remove();
    });

    // Xoá sạch class khỏi kết quả cuối — class của site gốc (Tailwind...) không có tác dụng
    // gì trong preview (không load CSS gốc), chỉ làm nặng HTML và có thể ẩn/lệch nội dung
    // qua các class kiểu animate/hidden mà style ép ở trên chưa phủ hết.
    clone.removeAttr('class');
    clone.find('*').removeAttr('class');

    const title = titleSelector ? $(titleSelector).first().text().trim() : null;
    const contentHtml = clone.html() || '';
    const textLength = clone.text().trim().length;

    console.log(`[preview] OK sau ${Date.now() - startedAt}ms, usedBrowser=${usedBrowser}, textLength=${textLength}`);
    res.json({ ok: true, title, contentHtml, textLength, usedBrowser });
  } catch (err) {
    if (err instanceof BlockedError) {
      console.warn(`[preview] BỊ CHẶN sau ${Date.now() - startedAt}ms: ${err.message}`);
      return res.json({ ok: false, blocked: true, blockType: err.info.type, error: err.message });
    }
    console.error(`[preview] LỖI sau ${Date.now() - startedAt}ms:`, err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ---- Test nút "chương kế" — chỉ 1 trang (nhanh) ----
app.post('/api/test-next', async (req, res) => {
  const { url, nextPageSelector, nextPageAttr, lastPageSelector, fetchMode, cookie } = req.body || {};
  if (!url) return res.status(400).json({ ok: false, error: 'Thiếu url (URL chương để test)' });
  if (!nextPageSelector) return res.status(400).json({ ok: false, error: 'Thiếu selector nút next' });

  console.log(`[test-next] ${url} | selector="${nextPageSelector}"`);
  try {
    const { html } = await fetchPage(url, { mode: fetchMode || 'auto' });
    const $ = cheerio.load(html);

    const nextEl = await resolveFirstMatch($, html, url, nextPageSelector);
    const matchCount = isXPath(nextPageSelector) ? (nextEl.length ? 1 : 0) : $(nextPageSelector).length;
    const disabled = isNextDisabled($, nextEl);
    const href = nextEl.length ? nextEl.attr(nextPageAttr || 'href') : null;
    const resolvedUrl = href ? new URL(href, url).toString() : null;
    const text = nextEl.length ? nextEl.text().trim().slice(0, 80) : null;
    const isLastMatch = lastPageSelector ? $(lastPageSelector).length > 0 : null;

    res.json({
      ok: true,
      matchCount,
      found: nextEl.length > 0,
      text,
      href,
      resolvedUrl,
      disabled,
      isLastPageMatch: isLastMatch,
    });
  } catch (err) {
    console.error(`[test-next] LỖI:`, err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ---- Test trang mục lục (chế độ song song, tuỳ chọn) — xem lấy được bao nhiêu chương ----
app.post('/api/test-toc', async (req, res) => {
  const {
    tocUrl,
    chapterLinkSelector,
    chapterLinkAttr,
    tocNextPageSelector,
    bookTitleSelector,
    authorSelector,
    coverSelector,
    coverAttr,
    fetchMode,
    cookie,
  } = req.body || {};
  if (!tocUrl) return res.status(400).json({ ok: false, error: 'Thiếu tocUrl' });
  if (!chapterLinkSelector) return res.status(400).json({ ok: false, error: 'Thiếu chapterLinkSelector' });

  console.log(`[test-toc] ${tocUrl} | selector="${chapterLinkSelector}"`);
  try {
    const { links, metadata } = await collectChapterLinksFromToc(
      {
        tocUrl,
        chapterLinkSelector,
        chapterLinkAttr,
        tocNextPageSelector,
        bookTitleSelector,
        authorSelector,
        coverSelector,
        coverAttr,
        fetchMode,
        cookie,
        maxTocPages: 200,
      },
      (msg) => console.log(`[test-toc] ${msg}`)
    );
    res.json({
      ok: true,
      total: links.length,
      firstFew: links.slice(0, 5),
      lastFew: links.length > 5 ? links.slice(-2) : [],
      metadata,
    });
  } catch (err) {
    if (err instanceof BlockedError) {
      return res.json({ ok: false, blocked: true, blockType: err.info.type, error: err.message });
    }
    console.error('[test-toc] LỖI:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ---- Danh sách sách đã/đang crawl (để hiển thị màn hình "tiếp tục hoặc xoá" lúc mở app) ----
app.get('/api/books', (req, res) => {
  const books = store.listBooks(OUTPUT_DIR).map((b) => ({
    slug: b.slug,
    bookTitle: b.bookTitle,
    startUrl: b.startUrl,
    status: b.status,
    chapterCount: b.chapterCount,
    lastUpdated: b.lastUpdated,
    downloadUrl: b.status === 'done' && b.epubFilename ? `download/${b.epubFilename}` : null,
  }));
  res.json({ ok: true, books });
});

app.get('/api/books/:slug/config', (req, res) => {
  if (!req.params.slug.startsWith('_book_')) return res.status(400).json({ ok: false, error: 'slug không hợp lệ' });
  const dir = path.join(OUTPUT_DIR, req.params.slug);
  const config = store.loadConfig(dir);
  if (!config) return res.status(404).json({ ok: false, error: 'Không tìm thấy cấu hình đã lưu cho sách này' });
  res.json({ ok: true, config });
});

app.delete('/api/books/:slug', (req, res) => {
  if (!req.params.slug.startsWith('_book_')) return res.status(400).json({ ok: false, error: 'slug không hợp lệ' });
  const dir = path.join(OUTPUT_DIR, req.params.slug);
  store.cleanupBookDir(dir);
  console.log(`[books] Đã xoá thư mục sách: ${dir}`);
  res.json({ ok: true });
});

// ---- Test nút "chương kế" — nối tiếp qua nhiều trang liên tục, để phát hiện selector
// đúng ở trang này nhưng lệch (bắt nhầm nút khác) ở trang sau, kiểu chương 1 không có nút
// "Trước" nhưng chương 2 trở đi có, làm lệch vị trí selector theo nth-child. ----
app.post('/api/test-next-chain', async (req, res) => {
  const { url, contentSelector, titleSelector, nextPageSelector, nextPageAttr, lastPageSelector, fetchMode, cookie, hops } =
    req.body || {};
  if (!url) return res.status(400).json({ ok: false, error: 'Thiếu url' });
  if (!nextPageSelector) return res.status(400).json({ ok: false, error: 'Thiếu selector nút next' });

  const maxHops = Math.min(Math.max(parseInt(hops, 10) || 5, 1), 15);
  const results = [];
  const visited = new Set();
  const seenTitles = [];
  let currentUrl = url;

  console.log(`[test-next-chain] Bắt đầu từ ${url}, tối đa ${maxHops} bước`);

  try {
    for (let i = 0; i < maxHops && currentUrl; i++) {
      if (visited.has(currentUrl)) {
        results.push({ url: currentUrl, problem: 'loop', note: 'Đã gặp lại URL này trong chuỗi test -> nghi lặp vòng do selector next bắt nhầm nút "Trước"' });
        break;
      }
      visited.add(currentUrl);

      const { html } = await fetchPage(currentUrl, { mode: fetchMode || 'auto', cookie });
      const $ = cheerio.load(html);

      const title = titleSelector ? $(titleSelector).first().text().trim() : null;

      const nextEl = await resolveFirstMatch($, html, currentUrl, nextPageSelector);
      const disabled = isNextDisabled($, nextEl);
      const href = nextEl.length ? nextEl.attr(nextPageAttr || 'href') : null;
      const resolvedUrl = href ? new URL(href, currentUrl).toString() : null;
      const isLastMatch = lastPageSelector ? $(lastPageSelector).length > 0 : null;

      let problem = null;
      if (titleSelector && !title) problem = 'no-title';
      else if (title && seenTitles.includes(title)) problem = 'dup-title';
      if (title) seenTitles.push(title);

      results.push({ url: currentUrl, title, href, resolvedUrl, disabled, isLastPageMatch: isLastMatch, problem });

      if (isLastMatch || disabled || !resolvedUrl) break;
      currentUrl = resolvedUrl;
    }
    res.json({ ok: true, results });
  } catch (err) {
    console.error('[test-next-chain] LỖI:', err.message);
    res.status(500).json({ ok: false, error: err.message, partial: results });
  }
});

// ---- Provider: lưu / lấy / xoá bộ selector đặt tên theo site, dùng lại cho lần sau ----
app.get('/api/providers', (req, res) => {
  res.json({ ok: true, providers: providerStore.list() });
});

app.get('/api/providers/:name', (req, res) => {
  const p = providerStore.get(req.params.name);
  if (!p) return res.status(404).json({ ok: false, error: 'Không tìm thấy provider' });
  res.json({ ok: true, provider: p });
});

app.post('/api/providers', (req, res) => {
  const { name, config } = req.body || {};
  try {
    const saved = providerStore.upsert(name, config || {});
    res.json({ ok: true, provider: saved });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

app.delete('/api/providers/:name', (req, res) => {
  const removed = providerStore.remove(req.params.name);
  res.json({ ok: true, removed });
});

// ---- Bước 2: Tạo (hoặc TIẾP TỤC) job crawl toàn bộ + đóng gói epub ----
app.post('/api/jobs', async (req, res) => {
  const config = req.body || {};
  const isTocMode = shouldUseTocMode(config);

  if (!config.contentSelector || (!isTocMode && !config.startUrl)) {
    return res.status(400).json({ ok: false, error: 'Thiếu startUrl/tocUrl hoặc contentSelector' });
  }

  const bookDir = store.bookDirFor(OUTPUT_DIR, config.bookTitle, config.startUrl || config.tocUrl);
  const existingMeta = store.loadMeta(bookDir);
  const isResume = !!existingMeta && existingMeta.status !== 'done';

  store.saveConfig(bookDir, config);

  const job = newJob(bookDir);
  job.bookTitle = config.bookTitle || null;
  job.resumed = isResume;
  if (isResume) job.chapterCount = existingMeta.chapterCount || 0;
  if (existingMeta?.totalKnown) job.totalKnown = existingMeta.totalKnown;
  res.json({ ok: true, jobId: job.id, resumed: isResume, resumedFromChapter: isResume ? existingMeta.chapterCount : 0 });

  (async () => {
    try {
      console.log(
        isResume
          ? `[job ${job.id}] TIẾP TỤC từ chương ${existingMeta.chapterCount} (thư mục: ${bookDir}, mode=${isTocMode ? 'toc' : 'next'})`
          : `[job ${job.id}] Bắt đầu crawl mới (mode=${isTocMode ? 'toc' : 'next'}, thư mục: ${bookDir})`
      );

      const persistence = {
        shouldStop: () => job.cancelRequested,
        onChapter: async (index, chapter) => {
          store.saveChapter(bookDir, index, chapter);
          job.chapterCount = Math.max(job.chapterCount, index);
        },
        onSkipped: async (skippedCount, url) => {
          job.skippedCount = skippedCount;
          console.log(`[job ${job.id}] Bỏ qua chương tại ${url} (tổng đã bỏ qua: ${skippedCount})`);
        },
      };

      if (isTocMode) {
        persistence.savedIndices = store.getSavedIndices(bookDir);
        persistence.onTotalKnown = async (total, metadata) => {
          job.totalKnown = total;
          if (metadata) {
            if (!config.bookTitle && metadata.bookTitle) {
              config.bookTitle = metadata.bookTitle;
              job.bookTitle = metadata.bookTitle;
              job.autoFilledBookTitle = metadata.bookTitle;
            }
            if (!config.author && metadata.author) config.author = metadata.author;
            if (!config.coverUrl && metadata.coverUrl) config.coverUrl = metadata.coverUrl;
          }
          store.saveMeta(bookDir, {
            bookTitle: config.bookTitle,
            startUrl: config.startUrl || config.tocUrl,
            createdAt: existingMeta?.createdAt || Date.now(),
            lastUpdated: Date.now(),
            chapterCount: job.chapterCount,
            totalKnown: total,
            status: 'in_progress',
          });
        };
      } else {
        // Khôi phục tập URL đã crawl (chống lặp vòng) từ các chương đã lưu trước đó.
        const visited = new Set();
        if (isResume) store.loadAllChapters(bookDir).forEach((c) => visited.add(c.url));
        persistence.visited = visited;
        persistence.resumeUrl = isResume ? existingMeta.nextUrl : undefined;
        persistence.startCount = isResume ? existingMeta.chapterCount || 0 : 0;
        persistence.onNextUrl = async (nextUrl) => {
          store.saveMeta(bookDir, {
            bookTitle: config.bookTitle,
            startUrl: config.startUrl,
            createdAt: existingMeta?.createdAt || Date.now(),
            lastUpdated: Date.now(),
            chapterCount: job.chapterCount,
            nextUrl,
            status: 'in_progress',
          });
        };
      }

      const { chapterCount, skippedCount } = await crawlBook(config, (progress) => {
        job.progress = progress;
        if (progress.total) job.totalKnown = progress.total;
        console.log(`[job ${job.id}] +chương ${progress.index}${progress.total ? `/${progress.total}` : ''}: ${progress.title}`);
      }, persistence);

      if (chapterCount === 0) {

        job.status = 'error';
        job.error = 'Không lấy được chương nào - kiểm tra lại các CSS selector.';
        return;
      }

      // Crawl xong toàn bộ (không bị PausedError) -> đọc HẾT chương đã lưu trên đĩa (kể cả
      // từ các lần chạy trước nếu có resume) rồi đóng gói epub.
      const allChapters = store.loadAllChapters(bookDir);

      const safeName = store.slugify(config.bookTitle) || 'book';
      const filename = `${safeName}_${Date.now()}.epub`;
      const outputPath = path.join(OUTPUT_DIR, filename);

      const { validationIssues } = await buildEpub({
        title: config.bookTitle,
        author: config.author,
        cover: config.coverUrl,
        chapters: allChapters,
        outputPath,
        customCss: config.customCss,
      });
      if (validationIssues && validationIssues.length > 0) {
        job.epubWarnings = validationIssues.length;
        console.warn(`[job ${job.id}] Epub tạo xong nhưng có ${validationIssues.length} cảnh báo validate XML (xem log ở trên) — file vẫn dùng được ở phần lớn reader.`);
      }

      store.saveMeta(bookDir, {
        bookTitle: config.bookTitle,
        startUrl: config.startUrl || config.tocUrl,
        createdAt: existingMeta?.createdAt || Date.now(),
        lastUpdated: Date.now(),
        chapterCount: allChapters.length,
        skippedCount: skippedCount || 0,
        nextUrl: null,
        status: 'done',
        epubFilename: filename,
      });

      job.status = 'done';
      job.chapterCount = allChapters.length;
      job.downloadUrl = `download/${filename}`;
      console.log(`[job ${job.id}] Hoàn tất: ${allChapters.length} chương -> ${filename}`);
    } catch (err) {
      if (err instanceof BlockedError) {
        console.warn(`[job ${job.id}] BỊ CHẶN: ${err.message}`);
        job.status = 'blocked';
        job.error = err.message;
      } else if (err instanceof PausedError) {
        if (err.info && err.info.cancelled) {
          console.log(`[job ${job.id}] ĐÃ DỪNG theo yêu cầu (đã lưu tiến độ): ${err.message}`);
          job.status = 'cancelled';
        } else {
          console.warn(`[job ${job.id}] TẠM DỪNG (đã lưu tiến độ): ${err.message}`);
          job.status = 'paused';
        }
        job.error = err.message;
      } else {
        console.error(`[job ${job.id}] LỖI:`, err.message);
        job.status = 'error';
        job.error = err.message;
      }
    }
  })();
});

app.post('/api/jobs/:id/cancel', (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ ok: false, error: 'Không tìm thấy job' });
  job.cancelRequested = true;
  console.log(`[job ${job.id}] Nhận yêu cầu dừng...`);
  res.json({ ok: true });
});

app.get('/api/jobs/:id', (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ ok: false, error: 'Không tìm thấy job' });
  res.json({ ok: true, ...job });
});

process.on('SIGINT', async () => {
  await closeBrowser();
  process.exit(0);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`WebToEpub app đang chạy tại http://localhost:${PORT}`));
