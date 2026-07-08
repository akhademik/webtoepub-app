const $ = (id) => document.getElementById(id);

function splitList(str) {
  return (str || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function guessDomain(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

// ==================== CHỌN MODE A / B ====================

const modeChoiceSection = $('modeChoice');
const step1Section = $('step1');
const step2Section = $('step2');
const changeModeBtn = $('changeModeBtn');
const modeOnlyEls = document.querySelectorAll('[data-mode-only]');

function currentCrawlMode() {
  const checked = document.querySelector('input[name="crawlMode"]:checked');
  return checked ? checked.value : null;
}

function applyModeVisibility() {
  const mode = currentCrawlMode();
  modeOnlyEls.forEach((el) => {
    el.hidden = el.getAttribute('data-mode-only') !== mode;
  });
}

document.querySelectorAll('input[name="crawlMode"]').forEach((radio) => {
  radio.addEventListener('change', () => {
    applyModeVisibility();
    modeChoiceSection.hidden = true;
    step1Section.hidden = false;
    window.scrollTo({ top: 0, behavior: 'smooth' });
  });
});

changeModeBtn.addEventListener('click', () => {
  step1Section.hidden = true;
  modeChoiceSection.hidden = false;
  window.scrollTo({ top: 0, behavior: 'smooth' });
});

// ==================== SÁCH ĐANG DỞ / ĐÃ XONG (lúc khởi động) ====================

const booksPanel = $('booksPanel');
const booksList = $('booksList');

const STATUS_LABEL = {
  in_progress: 'Đang crawl dở',
  paused: 'Tạm dừng (lỗi mạng)',
  cancelled: 'Đã dừng theo yêu cầu',
  done: 'Đã hoàn tất',
};

function fmtTime(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  return d.toLocaleString('vi-VN');
}

async function loadBooksPanel() {
  try {
    const res = await fetch('api/books');
    const data = await res.json();
    if (!data.ok || !data.books.length) {
      booksPanel.hidden = true;
      return;
    }

    booksList.innerHTML = '';
    data.books.forEach((b) => {
      const row = document.createElement('div');
      row.className = 'book-item';

      const info = document.createElement('div');
      info.className = 'book-info';
      const statusClass = `status-${b.status}`;
      info.innerHTML = `
        <div class="book-title">${escapeHtmlText(b.bookTitle || '(chưa đặt tên)')}</div>
        <div class="book-meta">
          <span class="book-status ${statusClass}">${STATUS_LABEL[b.status] || b.status}</span>
          ${b.chapterCount || 0} chương — cập nhật ${fmtTime(b.lastUpdated)}
        </div>`;

      const actions = document.createElement('div');
      actions.className = 'book-actions';

      if (b.status === 'done' && b.downloadUrl) {
        const dl = document.createElement('a');
        dl.className = 'btn btn-tiny btn-download';
        dl.href = b.downloadUrl;
        dl.textContent = 'Tải lại .epub';
        dl.setAttribute('download', '');
        actions.appendChild(dl);
      } else {
        const cont = document.createElement('button');
        cont.className = 'btn btn-tiny';
        cont.type = 'button';
        cont.textContent = 'Tiếp tục';
        cont.addEventListener('click', () => resumeBook(b.slug));
        actions.appendChild(cont);
      }

      const del = document.createElement('button');
      del.className = 'btn btn-tiny btn-danger';
      del.type = 'button';
      del.textContent = 'Xoá';
      del.addEventListener('click', () => deleteBook(b.slug, b.bookTitle));
      actions.appendChild(del);

      row.appendChild(info);
      row.appendChild(actions);
      booksList.appendChild(row);
    });

    booksPanel.hidden = false;
  } catch (err) {
    console.warn('Không tải được danh sách sách:', err.message);
  }
}

function escapeHtmlText(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

async function resumeBook(slug) {
  try {
    const res = await fetch(`api/books/${encodeURIComponent(slug)}/config`);
    const data = await res.json();
    if (!data.ok) {
      alert(`Lỗi: ${data.error}`);
      return;
    }
    const cfg = data.config;
    $('startUrl').value = cfg.startUrl || '';
    $('contentSelector').value = cfg.contentSelector || 'body';
    $('titleSelector').value = cfg.titleSelector || '';
    $('removeSelectors').value = (cfg.removeSelectors || []).join(', ');
    $('fetchMode').value = cfg.fetchMode || 'auto';
    $('bookTitle').value = cfg.bookTitle || '';
    $('author').value = cfg.author || '';
    $('coverUrl').value = cfg.coverUrl || '';
    $('nextPageSelector').value = cfg.nextPageSelector || '';
    $('lastPageSelector').value = cfg.lastPageSelector || '';
    $('cookie').value = cfg.cookie || '';
    $('customCss').value = cfg.customCss || '';
    $('tocUrl').value = cfg.tocUrl || '';
    $('chapterLinkSelector').value = cfg.chapterLinkSelector || '';
    $('tocNextPageSelector').value = cfg.tocNextPageSelector || '';
    $('concurrency').value = cfg.concurrency || 5;
    $('bookTitleSelector').value = cfg.bookTitleSelector || '';
    $('authorSelector').value = cfg.authorSelector || '';
    $('coverSelector').value = cfg.coverSelector || '';
    $('coverAttr').value = cfg.coverAttr || '';
    $('requestDelayMs').value = cfg.requestDelayMs || 0;

    step1Config = {
      startUrl: cfg.startUrl,
      contentSelector: cfg.contentSelector || 'body',
      titleSelector: cfg.titleSelector,
      removeSelectors: cfg.removeSelectors || [],
      fetchMode: cfg.fetchMode || 'auto',
    };

    const isTocProvider = !!(cfg.tocUrl && cfg.chapterLinkSelector);
    const radio = document.querySelector(`input[name="crawlMode"][value="${isTocProvider ? 'a' : 'b'}"]`);
    if (radio) {
      radio.checked = true;
      applyModeVisibility();
    }
    modeChoiceSection.hidden = true;
    step1.hidden = true;
    step2.hidden = false;
    window.scrollTo({ top: 0, behavior: 'smooth' });
    statusBox.hidden = false;
    statusLine.classList.remove('err');
    statusLine.textContent = `Đã tải lại cấu hình "${cfg.bookTitle || slug}" — bấm "Đóng sách EPUB" để tiếp tục từ chương đã dừng.`;
  } catch (err) {
    alert(`Lỗi tải cấu hình: ${err.message}`);
  }
}

async function deleteBook(slug, title) {
  if (!confirm(`Xoá toàn bộ dữ liệu đã crawl của "${title || slug}"? Không thể hoàn tác.`)) return;
  try {
    await fetch(`api/books/${encodeURIComponent(slug)}`, { method: 'DELETE' });
    await loadBooksPanel();
  } catch (err) {
    alert(`Lỗi xoá: ${err.message}`);
  }
}

loadBooksPanel();

// ==================== PROVIDER (bộ selector đã lưu) ====================

const providerSelect = $('providerSelect');
const providerName = $('providerName');
const saveProviderBtn = $('saveProviderBtn');
const deleteProviderBtn = $('deleteProviderBtn');
const providerSaveHint = $('providerSaveHint');

async function loadProviderList(selectName) {
  try {
    const res = await fetch('api/providers');
    const data = await res.json();
    if (!data.ok) return;
    providerSelect.innerHTML = '<option value="">— Chọn nếu đã lưu trước đó —</option>';
    data.providers.forEach((p) => {
      const opt = document.createElement('option');
      opt.value = p.name;
      opt.textContent = p.domain ? `${p.name} (${p.domain})` : p.name;
      providerSelect.appendChild(opt);
    });
    if (selectName) providerSelect.value = selectName;
  } catch (err) {
    console.warn('Không tải được danh sách provider:', err.message);
  }
}
loadProviderList();

function applyProviderToFields(cfg) {
  if (cfg.contentSelector !== undefined) $('contentSelector').value = cfg.contentSelector;
  if (cfg.titleSelector !== undefined) $('titleSelector').value = cfg.titleSelector;
  if (cfg.removeSelectors !== undefined) $('removeSelectors').value = (cfg.removeSelectors || []).join(', ');
  if (cfg.fetchMode !== undefined) $('fetchMode').value = cfg.fetchMode;
  if (cfg.nextPageSelector !== undefined) $('nextPageSelector').value = cfg.nextPageSelector;
  if (cfg.lastPageSelector !== undefined) $('lastPageSelector').value = cfg.lastPageSelector;
  if (cfg.customCss !== undefined) $('customCss').value = cfg.customCss;
  if (cfg.tocUrl !== undefined) $('tocUrl').value = cfg.tocUrl;
  if (cfg.chapterLinkSelector !== undefined) $('chapterLinkSelector').value = cfg.chapterLinkSelector;
  if (cfg.chapterLinkAttr !== undefined) $('chapterLinkAttr').value = cfg.chapterLinkAttr;
  if (cfg.tocNextPageSelector !== undefined) $('tocNextPageSelector').value = cfg.tocNextPageSelector;
  if (cfg.bookTitleSelector !== undefined) $('bookTitleSelector').value = cfg.bookTitleSelector;
  if (cfg.authorSelector !== undefined) $('authorSelector').value = cfg.authorSelector;
  if (cfg.coverSelector !== undefined) $('coverSelector').value = cfg.coverSelector;
  if (cfg.coverAttr !== undefined) $('coverAttr').value = cfg.coverAttr;
  if (cfg.concurrency !== undefined) $('concurrency').value = cfg.concurrency;

  // Provider lưu theo mục lục hay theo next-link -> tự chọn đúng thẻ A/B tương ứng.
  const isTocProvider = !!(cfg.tocUrl && cfg.chapterLinkSelector);
  const radio = document.querySelector(`input[name="crawlMode"][value="${isTocProvider ? 'a' : 'b'}"]`);
  if (radio) {
    radio.checked = true;
    applyModeVisibility();
    modeChoiceSection.hidden = true;
    step1Section.hidden = false;
  }
}

providerSelect.addEventListener('change', async () => {
  const name = providerSelect.value;
  if (!name) return;
  try {
    const res = await fetch(`api/providers/${encodeURIComponent(name)}`);
    const data = await res.json();
    if (!data.ok) {
      alert(`Lỗi tải provider: ${data.error}`);
      return;
    }
    applyProviderToFields(data.provider);
    providerName.value = name;
    deleteProviderBtn.hidden = false;
    providerSaveHint.textContent = `Đang dùng provider "${name}" — chỉnh selector rồi bấm "Lưu / cập nhật" để ghi đè, hoặc đổi tên để lưu thành provider mới.`;
  } catch (err) {
    alert(`Lỗi tải provider: ${err.message}`);
  }
});

saveProviderBtn.addEventListener('click', async () => {
  const name = providerName.value.trim();
  if (!name) {
    alert('Nhập tên cho provider trước đã (vd: tên miền trang truyện).');
    return;
  }
  const cfg = {
    domain: guessDomain($('tocUrl').value.trim() || $('startUrl').value.trim()) || undefined,
    contentSelector: $('contentSelector').value.trim() || 'body',
    titleSelector: $('titleSelector').value.trim() || undefined,
    removeSelectors: splitList($('removeSelectors').value),
    fetchMode: $('fetchMode').value,
    nextPageSelector: $('nextPageSelector').value.trim() || undefined,
    lastPageSelector: $('lastPageSelector').value.trim() || undefined,
    customCss: $('customCss').value.trim() || undefined,
    tocUrl: $('tocUrl').value.trim() || undefined,
    chapterLinkSelector: $('chapterLinkSelector').value.trim() || undefined,
    chapterLinkAttr: $('chapterLinkAttr').value.trim() || undefined,
    tocNextPageSelector: $('tocNextPageSelector').value.trim() || undefined,
    bookTitleSelector: $('bookTitleSelector').value.trim() || undefined,
    authorSelector: $('authorSelector').value.trim() || undefined,
    coverSelector: $('coverSelector').value.trim() || undefined,
    coverAttr: $('coverAttr').value.trim() || undefined,
    concurrency: parseInt($('concurrency').value.trim(), 10) || undefined,
  };
  try {
    const res = await fetch('api/providers', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, config: cfg }),
    });
    const data = await res.json();
    if (!data.ok) {
      alert(`Lỗi lưu provider: ${data.error}`);
      return;
    }
    await loadProviderList(name);
    deleteProviderBtn.hidden = false;
    providerSaveHint.textContent = `Đã lưu provider "${name}" — lần sau chọn lại ở dropdown trên cùng bước 1.`;
  } catch (err) {
    alert(`Lỗi lưu provider: ${err.message}`);
  }
});

deleteProviderBtn.addEventListener('click', async () => {
  const name = providerName.value.trim();
  if (!name) return;
  if (!confirm(`Xoá provider "${name}"? Không thể hoàn tác.`)) return;
  try {
    await fetch(`api/providers/${encodeURIComponent(name)}`, { method: 'DELETE' });
    providerName.value = '';
    deleteProviderBtn.hidden = true;
    providerSaveHint.textContent = 'Lưu lại bộ selector này để lần sau chọn nhanh từ dropdown ở bước 1, không cần dò lại từ đầu. Không lưu thì lần này vẫn dùng bình thường — không bắt buộc.';
    await loadProviderList();
  } catch (err) {
    alert(`Lỗi xoá provider: ${err.message}`);
  }
});

// ==================== BƯỚC 1: TEST / PREVIEW ====================

const testBtn = $('testBtn');
const applyBtn = $('applyBtn');
const previewPanel = $('previewPanel');
const previewTitle = $('previewTitle');
const previewMeta = $('previewMeta');
const previewFrame = $('previewFrame');
const previewError = $('previewError');
const stealthSuggest = $('stealthSuggest');
const stealthToggle = $('stealthToggle');

function collectStep1() {
  return {
    startUrl: $('startUrl').value.trim(),
    contentSelector: $('contentSelector').value.trim() || 'body',
    titleSelector: $('titleSelector').value.trim() || undefined,
    removeSelectors: splitList($('removeSelectors').value),
    fetchMode: $('fetchMode').value,
    stealth: !stealthSuggest.hidden && stealthToggle.checked,
    rotateUA: !stealthSuggest.hidden && stealthToggle.checked,
  };
}

function renderPreviewFrame(contentHtml, baseUrl) {
  const doc = `<!DOCTYPE html><html><head><meta charset="utf-8">
  <base href="${baseUrl}">
  <style>
    html,body{margin:0;padding:0;}
    body{
      font-family: Georgia, 'Source Serif 4', serif;
      font-size: 16px;
      line-height: 1.6;
      color: #1c1b19;
      padding: 1rem 1.2rem;
      max-width: 640px;
    }
    img{max-width:100%;height:auto;}
    * { box-sizing: border-box; }
    /* Ép luôn hiển thị — nhiều site (đặc biệt Next.js/React) style opacity:0, display:none,
       hoặc transform (translate/scale) để chờ JS "animate in" mới hiện ra đúng vị trí.
       Vì preview không chạy JS gốc, phải chủ động mở khoá hiển thị ở đây, nếu không nội dung
       có thật trong DOM nhưng vô hình / lệch vị trí ra ngoài khung nhìn. */
    * {
      opacity: 1 !important;
      visibility: visible !important;
      color: #1c1b19 !important;
      transform: none !important;
      filter: none !important;
      clip-path: none !important;
      max-height: none !important;
      overflow: visible !important;
    }
    [style*="display:none" i], [style*="display: none" i] { display: block !important; }
    dialog { display: block !important; }
  </style>
  </head><body>${contentHtml}</body></html>`;
  previewFrame.srcdoc = doc;
}

testBtn.addEventListener('click', async () => {
  const cfg = collectStep1();
  if (!cfg.startUrl) {
    const msg =
      currentCrawlMode() === 'a'
        ? 'Bấm "Test mục lục" trước để app tự lấy 1 URL chương mẫu, rồi mới Test nội dung được.'
        : 'Nhập URL chương 1 trước đã.';
    alert(msg);
    return;
  }

  previewPanel.hidden = true;
  previewError.hidden = true;
  stealthSuggest.hidden = true;
  testBtn.disabled = true;
  testBtn.textContent = 'Đang tải…';

  try {
    const res = await fetch('api/preview', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        url: cfg.startUrl,
        contentSelector: cfg.contentSelector,
        titleSelector: cfg.titleSelector,
        removeSelectors: cfg.removeSelectors,
        fetchMode: cfg.fetchMode,
      }),
    });
    const data = await res.json();

    if (!data.ok) {
      previewError.hidden = false;
      if (data.blocked) {
        previewError.textContent = `⚠ Trang có vẻ bị chặn bot hoặc yêu cầu đăng nhập/VIP: ${data.error}`;
        stealthSuggest.hidden = false;
      } else {
        previewError.textContent = `Lỗi: ${data.error}`;
      }
      return;
    }

    previewTitle.textContent = data.title || '(không tìm thấy tiêu đề — kiểm tra lại selector tiêu đề)';
    previewMeta.textContent = `${data.textLength.toLocaleString('vi-VN')} ký tự${data.usedBrowser ? ' — đã dùng trình duyệt headless' : ' — tải tĩnh'}`;
    renderPreviewFrame(data.contentHtml, cfg.startUrl);
    $('rawHtmlBox').value = data.contentHtml;
    previewPanel.hidden = false;

    // Static không đủ, phải rơi vào browser -> site này khả năng có chống bot cơ bản.
    // Gợi ý bật thêm cơ chế né chặn cho lúc crawl thật (không tự ý bật, để người dùng quyết).
    if (data.usedBrowser && cfg.fetchMode !== 'browser') {
      stealthSuggest.hidden = false;
      $('fetchMode').value = 'browser';
    }
  } catch (err) {
    previewError.hidden = false;
    previewError.textContent = `Lỗi kết nối: ${err.message}`;
  } finally {
    testBtn.disabled = false;
    testBtn.textContent = 'Test';
  }
});

// ==================== CHUYỂN SANG BƯỚC 2 ====================

const step1 = $('step1');
const step2 = $('step2');
const backBtn = $('backBtn');

let step1Config = null;

applyBtn.addEventListener('click', () => {
  const cfg = collectStep1();
  if (!cfg.startUrl) {
    const msg =
      currentCrawlMode() === 'a'
        ? 'Bấm "Test mục lục" trước để app lấy được ít nhất 1 chương mẫu, rồi mới tiếp tục được.'
        : 'Nhập URL chương 1 trước đã.';
    alert(msg);
    return;
  }
  step1Config = cfg;
  step1.hidden = true;
  step2.hidden = false;
  if (!providerName.value.trim()) {
    providerName.value = guessDomain($('tocUrl').value.trim() || cfg.startUrl);
  }
  window.scrollTo({ top: 0, behavior: 'smooth' });
});

backBtn.addEventListener('click', () => {
  step2.hidden = true;
  step1.hidden = false;
  window.scrollTo({ top: 0, behavior: 'smooth' });
});

// ==================== TEST NÚT "NEXT" ====================

const testNextBtn = $('testNextBtn');
const testNextResult = $('testNextResult');

testNextBtn.addEventListener('click', async () => {
  if (!step1Config) {
    alert('Cần hoàn tất bước 1 trước (cần URL chương 1 để test).');
    return;
  }
  const nextSel = $('nextPageSelector').value.trim();
  if (!nextSel) {
    alert('Nhập selector nút next trước đã.');
    return;
  }

  testNextBtn.disabled = true;
  testNextBtn.textContent = 'Đang test…';
  testNextResult.hidden = true;
  testNextResult.classList.remove('ok', 'bad');

  try {
    const res = await fetch('api/test-next', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        url: step1Config.startUrl,
        nextPageSelector: nextSel,
        lastPageSelector: $('lastPageSelector').value.trim() || undefined,
        fetchMode: step1Config.fetchMode,
      }),
    });
    const data = await res.json();
    testNextResult.hidden = false;

    if (!data.ok) {
      testNextResult.classList.add('bad');
      testNextResult.textContent = `Lỗi: ${data.error}`;
      return;
    }

    if (!data.found) {
      testNextResult.classList.add('bad');
      testNextResult.textContent = `Không tìm thấy phần tử nào khớp selector này trên trang chương 1.`;
      return;
    }

    const lines = [
      `Tìm thấy ${data.matchCount} phần tử khớp (dùng phần tử đầu tiên).`,
      `Chữ trên nút: "${data.text || '(rỗng)'}"`,
      `href: ${data.href || '(không có)'}`,
      data.resolvedUrl ? `-> URL kế tiếp sẽ là: ${data.resolvedUrl}` : null,
      `Trạng thái: ${data.disabled ? 'BỊ COI LÀ DISABLED (sẽ dừng ở đây nếu đây là trang cuối thật)' : 'Bình thường (sẽ tiếp tục crawl)'}`,
      data.isLastPageMatch !== null ? `Khớp lastPageSelector: ${data.isLastPageMatch ? 'Có' : 'Không'}` : null,
    ].filter(Boolean);

    testNextResult.classList.add(data.disabled && data.matchCount > 1 ? 'bad' : 'ok');
    testNextResult.textContent = lines.join('\n');
  } catch (err) {
    testNextResult.hidden = false;
    testNextResult.classList.add('bad');
    testNextResult.textContent = `Lỗi kết nối: ${err.message}`;
  } finally {
    testNextBtn.disabled = false;
    testNextBtn.textContent = 'Test 1 trang';
  }
});

// ==================== TEST NÚT "NEXT" — CHUỖI NHIỀU TRANG ====================

const testNextChainBtn = $('testNextChainBtn');

testNextChainBtn.addEventListener('click', async () => {
  if (!step1Config) {
    alert('Cần hoàn tất bước 1 trước (cần URL chương 1 để test).');
    return;
  }
  const nextSel = $('nextPageSelector').value.trim();
  if (!nextSel) {
    alert('Nhập selector nút next trước đã.');
    return;
  }

  testNextChainBtn.disabled = true;
  testNextChainBtn.textContent = 'Đang test…';
  testNextResult.hidden = true;
  testNextResult.classList.remove('ok', 'bad');

  try {
    const res = await fetch('api/test-next-chain', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        url: step1Config.startUrl,
        contentSelector: step1Config.contentSelector,
        titleSelector: step1Config.titleSelector,
        nextPageSelector: nextSel,
        lastPageSelector: $('lastPageSelector').value.trim() || undefined,
        fetchMode: step1Config.fetchMode,
        hops: 5,
      }),
    });
    const data = await res.json();
    testNextResult.hidden = false;

    if (!data.ok) {
      testNextResult.classList.add('bad');
      testNextResult.textContent = `Lỗi: ${data.error}`;
      return;
    }

    let hasProblem = false;
    const lines = data.results.map((r, i) => {
      if (r.problem === 'loop') {
        hasProblem = true;
        return `Bước ${i + 1}: ⚠ ${r.note}`;
      }
      let warn = '';
      if (r.problem === 'no-title') {
        warn = '  ⚠ không lấy được tiêu đề — kiểm tra lại selector tiêu đề';
        hasProblem = true;
      } else if (r.problem === 'dup-title') {
        warn = '  ⚠ tiêu đề TRÙNG với 1 bước trước đó — nghi bị lặp lại chương cũ';
        hasProblem = true;
      }
      const doneNote = r.disabled ? '  (nút next disable ở đây — coi là hết truyện)' : '';
      return `Bước ${i + 1}: ${r.title || '(không có tiêu đề)'}${doneNote}${warn}`;
    });

    testNextResult.classList.add(hasProblem ? 'bad' : 'ok');
    testNextResult.textContent =
      lines.join('\n') +
      (hasProblem
        ? '\n\n⚠ Có vấn đề — kiểm tra lại các tiêu đề ở trên, nếu bị trùng lặp thì selector next đang bắt nhầm.'
        : '\n\n✓ Tiêu đề tăng dần đúng thứ tự qua tất cả các bước — selector ổn.');
  } catch (err) {
    testNextResult.hidden = false;
    testNextResult.classList.add('bad');
    testNextResult.textContent = `Lỗi kết nối: ${err.message}`;
  } finally {
    testNextChainBtn.disabled = false;
    testNextChainBtn.textContent = 'Test 5 trang liên tiếp';
  }
});

// ==================== TEST MỤC LỤC (chế độ song song, tuỳ chọn) ====================

const testTocBtn = $('testTocBtn');
const testTocResult = $('testTocResult');

testTocBtn.addEventListener('click', async () => {
  const tocUrl = $('tocUrl').value.trim();
  const chapterLinkSelector = $('chapterLinkSelector').value.trim();
  if (!tocUrl || !chapterLinkSelector) {
    alert('Nhập URL mục lục và selector link chương trước đã.');
    return;
  }

  testTocBtn.disabled = true;
  testTocBtn.textContent = 'Đang test…';
  testTocResult.hidden = true;
  testTocResult.classList.remove('ok', 'bad');

  try {
    const res = await fetch('api/test-toc', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        tocUrl,
        chapterLinkSelector,
        tocNextPageSelector: $('tocNextPageSelector').value.trim() || undefined,
        bookTitleSelector: $('bookTitleSelector').value.trim() || undefined,
        authorSelector: $('authorSelector').value.trim() || undefined,
        coverSelector: $('coverSelector').value.trim() || undefined,
        coverAttr: $('coverAttr').value.trim() || undefined,
        fetchMode: step1Config ? step1Config.fetchMode : 'auto',
      }),
    });
    const data = await res.json();
    testTocResult.hidden = false;

    if (!data.ok) {
      testTocResult.classList.add('bad');
      testTocResult.textContent = data.blocked ? `⚠ Trang mục lục có vẻ bị chặn: ${data.error}` : `Lỗi: ${data.error}`;
      return;
    }

    testTocResult.classList.add(data.total > 0 ? 'ok' : 'bad');

    // Rút gọn URL cùng gốc với tocUrl -> chỉ hiện phần đường dẫn, đỡ rối mắt.
    const shorten = (url) => {
      try {
        const base = new URL(tocUrl);
        const u = new URL(url);
        if (u.origin === base.origin) return `…${u.pathname}${u.search}`;
        return url;
      } catch {
        return url;
      }
    };

    const sampleLines = data.firstFew.map((u) => shorten(u));
    const tailLines = data.lastFew.map((u) => shorten(u));

    // Tự điền chương đầu tiên vào ô startUrl (ẩn ở mode A) để nút "Test nội dung chương"
    // và bước crawl-config dùng lại được, không cần người dùng tự đi tìm URL chương mẫu.
    if (data.firstFew[0]) {
      $('startUrl').value = data.firstFew[0];
    }

    const meta = data.metadata || {};
    const wantTitle = $('bookTitleSelector').value.trim();
    const wantAuthor = $('authorSelector').value.trim();
    const wantCover = $('coverSelector').value.trim();

    testTocResult.innerHTML = '';

    if (wantTitle || wantAuthor || wantCover) {
      const metaRow = document.createElement('div');
      metaRow.className = 'toc-result-meta';

      if (wantCover) {
        const img = document.createElement('img');
        img.className = 'toc-result-cover';
        img.alt = 'Ảnh bìa';
        img.src = meta.coverUrl || '';
        img.onerror = () => { img.style.visibility = 'hidden'; };
        metaRow.appendChild(img);
      }

      const textCol = document.createElement('div');
      textCol.className = 'toc-result-text';
      const lines = [];
      if (wantTitle) lines.push(['Tên sách', meta.bookTitle || '(không tìm thấy)']);
      if (wantAuthor) lines.push(['Tác giả', meta.author || '(không tìm thấy)']);
      lines.forEach(([label, val]) => {
        const p = document.createElement('div');
        const strong = document.createElement('strong');
        strong.textContent = label + ':';
        p.appendChild(strong);
        p.appendChild(document.createTextNode(' ' + val));
        textCol.appendChild(p);
      });
      metaRow.appendChild(textCol);
      testTocResult.appendChild(metaRow);
    }

    const countLine = document.createElement('div');
    countLine.className = 'toc-result-count';
    countLine.textContent = `Tìm thấy tổng: ${data.total} chương` + (data.firstFew[0] ? ' — đã lấy chương đầu làm mẫu, bấm "Test nội dung chương" bên dưới để xem thử.' : '');
    testTocResult.appendChild(countLine);

    if (data.total > 0) {
      const linksBox = document.createElement('div');
      linksBox.className = 'toc-result-links';
      const shown = tailLines.length ? [...sampleLines, '...', ...tailLines] : sampleLines;
      linksBox.textContent = shown.join('\n');
      testTocResult.appendChild(linksBox);
    } else {
      const warn = document.createElement('div');
      warn.textContent = '⚠ Không tìm thấy link nào — kiểm tra lại selector hoặc thử đổi "Chế độ tải trang" ở bước 1 sang browser.';
      testTocResult.appendChild(warn);
    }
  } catch (err) {
    testTocResult.hidden = false;
    testTocResult.classList.add('bad');
    testTocResult.textContent = `Lỗi kết nối: ${err.message}`;
  } finally {
    testTocBtn.disabled = false;
    testTocBtn.textContent = 'Test mục lục';
  }
});

// ==================== BƯỚC 2: TẠO EPUB ====================

const generateBtn = $('generateBtn');
const cancelBtn = $('cancelBtn');
const statusBox = $('status');
const statusLine = $('statusLine');
const stack = $('stack');
const downloadLink = $('downloadLink');
let currentJobId = null;

function resetStatus() {
  statusBox.hidden = false;
  statusLine.classList.remove('err');
  statusLine.textContent = 'Đang bắt đầu…';
  stack.innerHTML = '';
  downloadLink.hidden = true;
}

function addStackBar() {
  const bar = document.createElement('div');
  bar.className = 'stack-bar';
  stack.appendChild(bar);
  while (stack.children.length > 60) stack.removeChild(stack.firstChild);
}

generateBtn.addEventListener('click', async () => {
  if (!step1Config) {
    alert('Cần hoàn tất bước 1 trước.');
    return;
  }

  const mode = currentCrawlMode(); // 'a' | 'b'
  const tocUrl = $('tocUrl').value.trim();
  const chapterLinkSelector = $('chapterLinkSelector').value.trim();

  // QUAN TRỌNG: chỉ lấy field đúng theo mode đang chọn, KHÔNG đọc field của mode kia dù nó
  // có giá trị gì còn sót lại trong DOM (ví dụ trước đó test mode B rồi mới đổi sang mode A) —
  // tránh rò rỉ giá trị cũ (đã từng gây lỗi: bookTitle "Truyện" còn sót lại ghi đè lên tên
  // sách đáng lẽ phải tự lấy từ bookTitleSelector).
  const cfg = {
    ...step1Config,
    bookTitle: mode === 'a' ? undefined : $('bookTitle').value.trim(),
    author: mode === 'a' ? undefined : $('author').value.trim(),
    coverUrl: mode === 'a' ? undefined : $('coverUrl').value.trim() || undefined,
    cookie: $('cookie').value.trim() || undefined,
    customCss: $('customCss').value.trim() || undefined,
    requestDelayMs: parseInt($('requestDelayMs').value.trim(), 10) || 0,

    nextPageSelector: mode === 'b' ? $('nextPageSelector').value.trim() || undefined : undefined,
    lastPageSelector: mode === 'b' ? $('lastPageSelector').value.trim() || undefined : undefined,

    tocUrl: mode === 'a' ? tocUrl || undefined : undefined,
    chapterLinkSelector: mode === 'a' ? chapterLinkSelector || undefined : undefined,
    tocNextPageSelector: mode === 'a' ? $('tocNextPageSelector').value.trim() || undefined : undefined,
    concurrency: mode === 'a' ? parseInt($('concurrency').value.trim(), 10) || 5 : undefined,
    bookTitleSelector: mode === 'a' ? $('bookTitleSelector').value.trim() || undefined : undefined,
    authorSelector: mode === 'a' ? $('authorSelector').value.trim() || undefined : undefined,
    coverSelector: mode === 'a' ? $('coverSelector').value.trim() || undefined : undefined,
    coverAttr: mode === 'a' ? $('coverAttr').value.trim() || undefined : undefined,
  };

  const usingToc = !!(cfg.tocUrl && cfg.chapterLinkSelector);
  const canAutoFillTitle = usingToc && cfg.bookTitleSelector;

  if (!cfg.bookTitle && !canAutoFillTitle) {
    alert('Nhập tên sách trước đã — tên sách dùng để xác định thư mục lưu tiến độ, cần thiết để có thể tiếp tục nếu bị gián đoạn giữa chừng. (Hoặc điền "CSS selector — tên sách" trong Chế độ mục lục để app tự lấy.)');
    return;
  }

  if (!usingToc && !cfg.nextPageSelector) {
    if (!confirm('Bạn chưa nhập selector "chương kế" — app sẽ chỉ lấy đúng 1 chương (chương 1). Tiếp tục?')) {
      return;
    }
  }

  generateBtn.disabled = true;
  resetStatus();

  try {
    const res = await fetch('api/jobs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(cfg),
    });
    const data = await res.json();
    if (!data.ok) {
      statusLine.textContent = `Lỗi: ${data.error}`;
      statusLine.classList.add('err');
      generateBtn.disabled = false;
      return;
    }
    if (data.resumed) {
      statusLine.textContent = `Đang tiếp tục từ chương ${data.resumedFromChapter} (đã lưu từ lần chạy trước)…`;
      for (let i = 0; i < data.resumedFromChapter; i++) addStackBar();
      seenIndexOverride = data.resumedFromChapter;
    }
    currentJobId = data.jobId;
    cancelBtn.hidden = false;
    cancelBtn.disabled = false;
    cancelBtn.textContent = 'Dừng';
    pollJob(data.jobId);
  } catch (err) {
    statusLine.textContent = `Lỗi: ${err.message}`;
    statusLine.classList.add('err');
    generateBtn.disabled = false;
  }
});

cancelBtn.addEventListener('click', async () => {
  if (!currentJobId) return;
  if (!confirm('Dừng crawl? Tiến độ đã lấy được vẫn được giữ, có thể bấm "Đóng sách EPUB" để tiếp tục sau.')) return;
  cancelBtn.disabled = true;
  cancelBtn.textContent = 'Đang dừng…';
  try {
    await fetch(`api/jobs/${currentJobId}/cancel`, { method: 'POST' });
    statusLine.textContent = 'Đang dừng — chờ chương đang tải xong (có thể mất vài giây)...';
  } catch (err) {
    cancelBtn.disabled = false;
    cancelBtn.textContent = 'Dừng';
    alert(`Lỗi khi gửi yêu cầu dừng: ${err.message}`);
  }
});

let seenIndex = 0;
let seenIndexOverride = null;
let activePollJobId = null; // dùng để dừng vòng poll khi người dùng bấm "Trang chủ" giữa chừng

async function pollJob(jobId) {
  activePollJobId = jobId;
  seenIndex = seenIndexOverride !== null ? seenIndexOverride : 0;
  seenIndexOverride = null;
  const tick = async () => {
    if (activePollJobId !== jobId) return; // đã rời màn hình theo dõi job này -> dừng hẳn, đỡ tốn request
    try {
      const res = await fetch(`api/jobs/${jobId}`);
      const job = await res.json();
      if (!job.ok) {
        statusLine.textContent = `Lỗi: ${job.error}`;
        statusLine.classList.add('err');
        generateBtn.disabled = false;
        cancelBtn.hidden = true;
        return;
      }

      if (job.progress && job.progress.index > seenIndex) {
        for (let i = seenIndex; i < job.progress.index; i++) addStackBar();
        seenIndex = job.progress.index;
        const total = job.totalKnown || job.progress.total;
        const percentPart = total > 0 ? ` (${Math.min(100, Math.round((job.progress.index / total) * 100))}% / ${total} chương)` : '';
        statusLine.textContent = `Đã lấy ${job.progress.index} chương${percentPart} — mới nhất: ${job.progress.title || '(không có tiêu đề)'}`;
      }

      if (job.status === 'running') {
        setTimeout(tick, 1200);
      } else if (job.status === 'done') {
        statusLine.textContent = `Hoàn tất — ${job.chapterCount} chương. Sẵn sàng tải xuống.`;
        downloadLink.href = job.downloadUrl;
        downloadLink.hidden = false;
        generateBtn.disabled = false;
        cancelBtn.hidden = true;
      } else if (job.status === 'paused') {
        statusLine.textContent = `⏸ Tạm dừng ở chương ${job.chapterCount} do lỗi mạng/site chặn: ${job.error} — Tiến độ đã được lưu. Bấm "Đóng sách EPUB" lần nữa để tự động tiếp tục từ đây.`;
        generateBtn.disabled = false;
        cancelBtn.hidden = true;
      } else if (job.status === 'cancelled') {
        statusLine.textContent = `⏹ Đã dừng theo yêu cầu ở chương ${job.chapterCount}. Tiến độ đã được lưu. Bấm "Đóng sách EPUB" lần nữa để tiếp tục từ đây.`;
        generateBtn.disabled = false;
        cancelBtn.hidden = true;
      } else if (job.status === 'blocked') {
        statusLine.textContent = `🚫 Bị chặn ở chương ${job.chapterCount}: ${job.error} — Tiến độ đã được lưu. Đây thường KHÔNG tự hết bằng cách thử lại (khác lỗi mạng tạm thời) — cần đăng nhập/mua VIP/thêm cookie, hoặc bật chế độ né chặn ở bước 1, rồi mới bấm "Đóng sách EPUB" lại để tiếp tục.`;
        statusLine.classList.add('err');
        generateBtn.disabled = false;
        cancelBtn.hidden = true;
      } else {
        statusLine.textContent = `Lỗi: ${job.error}`;
        statusLine.classList.add('err');
        generateBtn.disabled = false;
        cancelBtn.hidden = true;
      }
    } catch (err) {
      statusLine.textContent = `Lỗi kết nối: ${err.message}`;
      statusLine.classList.add('err');
      generateBtn.disabled = false;
      cancelBtn.hidden = true;
    }
  };
  tick();
}

// ==================== NÚT "TRANG CHỦ" — quay lại màn hình ban đầu bất cứ lúc nào,
// không cần bấm refresh trình duyệt. Trước đây thiếu nút này (chỉ có "← Đổi cách lấy
// chương" và "← Chỉnh lại bước 1", đều chỉ lùi đúng 1 bước chứ không có đường về hẳn). ====================

const homeBtn = $('homeBtn');

function goHome() {
  // Job (nếu có) vẫn tiếp tục chạy NỀN trên server bình thường — chỉ dừng poll cập nhật
  // giao diện của lần xem này. Lúc cần xem lại tiến độ, bấm "Tiếp tục" ở màn "Sách đã lưu
  // trên máy" bên dưới là ra ngay, không mất gì cả.
  activePollJobId = null;

  step1.hidden = true;
  step2.hidden = true;
  modeChoiceSection.hidden = false;

  // Bỏ chọn mode A/B đã chọn trước đó — về trang chủ là coi như bắt đầu lại từ đầu, tránh
  // lẫn cấu hình của cuốn cũ sang cuốn mới nếu người dùng quên đổi.
  document.querySelectorAll('input[name="crawlMode"]').forEach((r) => (r.checked = false));
  step1Config = null;

  statusBox.hidden = true;
  downloadLink.hidden = true;
  generateBtn.disabled = false;
  cancelBtn.hidden = true;

  loadBooksPanel(); // làm mới danh sách — job vừa bắt đầu/vừa xong có thể vừa đổi trạng thái
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

homeBtn.addEventListener('click', goHome);
