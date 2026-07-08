// Hỗ trợ XPath cho các selector "next"/pagination — hữu ích khi site dùng class kiểu
// Tailwind (không có class ổn định) nhưng có thể tìm theo NỘI DUNG CHỮ, ví dụ:
//   xpath://a[contains(text(), "Tiếp")]
// cheerio không hỗ trợ XPath, nên dùng document.evaluate() gốc của trình duyệt qua
// Playwright — không cần thêm thư viện parse HTML-as-XML (vốn dễ vỡ với HTML thật).
//
// Trước đây module này tự launch RIÊNG 1 browser Chromium (sharedBrowserPromise), tách
// biệt hoàn toàn với browser của fetcher.js. Hậu quả: crawl dùng browser-mode + XPath
// "next" selector cùng lúc sẽ chạy 2 tiến trình Chromium song song (gấp đôi RAM), và
// closeBrowser() ở server.js lúc SIGINT chỉ đóng browser của fetcher.js -> tiến trình
// Chromium thứ 2 bị leak (không tắt) mỗi lần app dừng. Giờ dùng CHUNG 1 browser với
// fetcher.js qua getBrowser() để tránh trùng lặp và leak.
const { getBrowser } = require('./fetcher');

async function getSharedBrowser() {
  return getBrowser();
}

/** Nhận diện 1 chuỗi selector có phải XPath không: tiền tố "xpath:" tường minh,
 * hoặc bắt đầu bằng "/" / "//" / "(" (cú pháp XPath thông thường). */
function isXPath(selector) {
  if (!selector) return false;
  const s = selector.trim();
  return s.startsWith('xpath:') || s.startsWith('//') || s.startsWith('/') || s.startsWith('(');
}

function cleanXPath(selector) {
  return selector.trim().replace(/^xpath:/, '');
}

/** Chạy 1 biểu thức XPath trên chuỗi HTML, trả về mảng thông tin phần tử khớp
 * (chỉ những trường cần cho việc điều hướng "next": href, class, disabled...). */
async function queryXPathAll(html, xpathExpr, baseUrl) {
  const browser = await getSharedBrowser();
  const page = await browser.newPage();
  try {
    const htmlWithBase = /<base\s/i.test(html)
      ? html
      : html.replace(/<head[^>]*>/i, (m) => `${m}<base href="${baseUrl}">`);
    await page.setContent(htmlWithBase, { waitUntil: 'domcontentloaded' });
    const nodes = await page.evaluate((expr) => {
      const result = document.evaluate(expr, document, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
      const out = [];
      for (let i = 0; i < result.snapshotLength; i++) {
        const n = result.snapshotItem(i);
        if (n.nodeType !== 1) continue; // chỉ lấy element, bỏ qua text node nếu xpath trỏ vào text()
        out.push({
          tagName: n.tagName.toLowerCase(),
          href: n.getAttribute('href'),
          className: n.getAttribute('class') || '',
          disabled: n.hasAttribute('disabled'),
          ariaDisabled: n.getAttribute('aria-disabled'),
          text: (n.textContent || '').trim(),
        });
      }
      return out;
    }, xpathExpr);
    return nodes;
  } finally {
    await page.close();
  }
}

/** Bọc kết quả XPath thành 1 object có cùng "giao diện" tối thiểu với phần tử cheerio
 * (.attr(), .text(), .is(), .length) để tái dùng nguyên logic isNextDisabled() hiện có. */
function wrapXPathNode(node) {
  if (!node) return { length: 0, attr: () => undefined, text: () => '', is: () => false };
  return {
    length: 1,
    attr(name) {
      if (name === 'href') return node.href ?? undefined;
      if (name === 'class') return node.className || undefined;
      if (name === 'disabled') return node.disabled ? '' : undefined;
      if (name === 'aria-disabled') return node.ariaDisabled ?? undefined;
      return undefined;
    },
    text() {
      return node.text || '';
    },
    is(tag) {
      return node.tagName === String(tag).toLowerCase();
    },
  };
}

/** API chính: cho HTML + 1 selector (CSS hoặc XPath) + baseUrl, trả về phần tử ĐẦU TIÊN
 * khớp, bọc sẵn theo giao diện cheerio-like. Dùng khi cần xử lý cả 2 loại selector
 * đồng nhất (chủ yếu cho next-page/pagination). */
async function resolveFirstMatch($, html, baseUrl, selector) {
  if (!selector) return { length: 0, attr: () => undefined, text: () => '', is: () => false };
  if (isXPath(selector)) {
    const nodes = await queryXPathAll(html, cleanXPath(selector), baseUrl);
    return wrapXPathNode(nodes[0]);
  }
  return $(selector).first();
}

// Không cần closeSharedBrowser riêng nữa — browser giờ dùng chung với fetcher.js,
// nên việc đóng browser (lúc SIGINT) chỉ cần gọi closeBrowser() từ fetcher.js là đủ,
// tránh 2 nơi cùng "sở hữu" vòng đời của 1 browser instance.
module.exports = { isXPath, cleanXPath, queryXPathAll, wrapXPathNode, resolveFirstMatch };