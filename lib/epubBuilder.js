const fs = require('fs');
const crypto = require('crypto');
const axios = require('axios');
const JSZip = require('jszip');
const { DOMParser } = require('@xmldom/xmldom');

// ============================================================================
// Đóng gói EPUB THỦ CÔNG bằng jszip (thay cho epub-gen).
//
// LÝ DO ĐỔI: epub-gen (bản 0.1.x) đã ngừng cập nhật nhiều năm và có cách xử lý
// `excludeFromToc` khá tệ — nó không chỉ bỏ chương khỏi mục lục điều hướng (nav/ncx)
// như tên gọi, mà còn LÀM RỚT LUÔN chương đó khỏi <spine> (thứ tự đọc thật của epub).
// Reader (Calibre...) thấy 1 file xhtml có trong <manifest> nhưng KHÔNG có trong
// <spine> thì coi nó là "không thuộc luồng đọc" -> xếp vào mục "Miscellaneous",
// và vì không thuộc spine nên các công cụ build mục lục từ heading (Calibre) cũng
// không quét qua được.
//
// Ở bản build tay này: MỌI chương luôn nằm trong <spine> theo đúng thứ tự (nên Calibre
// luôn thấy đủ, luôn tự build lại mục lục từ heading <h2> được nếu người dùng muốn).
// Trang mục lục điều hướng (nav.xhtml, dùng cho EPUB3) và toc.ncx (cho EPUB2/Kindle)
// vẫn được sinh ra đầy đủ và hợp lệ (bắt buộc theo chuẩn EPUB), NHƯNG nav.xhtml
// KHÔNG được đưa vào <spine> — vì vậy mở sách sẽ vào thẳng bìa/chương 1 luôn, không
// phải bấm qua trang mục lục trước. Reader vẫn có thể tự hiện menu "Mục lục" lấy từ
// nav.xhtml/toc.ncx bình thường, chỉ là nó không nằm trên luồng lật trang tuần tự.
//
// LƯU Ý: không nhúng ảnh trong nội dung chương (sách toàn chữ) — chỉ còn tải ảnh BÌA
// (metadata sách, không phải nội dung chương) nên vẫn cần axios cho việc đó.
// ============================================================================

// CSS mặc định nhúng vào mọi EPUB xuất ra — canh chỉnh cho việc đọc thoải mái trên
// Kindle/Kobo/Calibre, style riêng cho tiêu đề chương dạng "số chương" + "tên chương".
const DEFAULT_CSS = `
@page {
  margin-top: 0; /* Xóa lề mặc định của trang để sửa lỗi h2 bị đẩy xuống */
}
body {
  font-family: "Bookerly", serif;
  margin-top: 0 !important;
  padding-top: 0 !important;
}
p {
  display: block;
  text-align: justify;
  line-height: 1.4;
  text-indent: 1.25em;
  padding-top: 0.5em;
  margin: 0;
}
a {
  text-decoration: none;
  font-size: 0.6em;
  vertical-align: super;
}
aside.footnote {
  display: block;
  color: green;
  padding-bottom: 0.5em;
}
div#book-columns aside.footnote {
  display: none;
}
p:last-of-type {
  margin-bottom: 2.5em;
}
h2 {
  margin-top: 0 !important;
  padding-top: 0 !important;
  line-height: 1.1;
  text-align: center;
  margin-bottom: 0.5em;
  font-size: 1.05em;
}
h2 span.ch-num {
  display: inline-block;
  font-size: 0.35em;
  letter-spacing: 0.1em;
  opacity: 0.6;
  text-transform: uppercase;
  padding-bottom: 0.4em;
  border-bottom: 1px solid currentColor;
}
h2 span.sep {
  display: none;
}
h2 span.ch-title {
  display: block;
  font-size: 1.05em;
  text-transform: capitalize;
}
`.trim();

/**
 * Chỉ tách thành ch-num/sep/ch-title khi tiêu đề khớp đúng dạng "Chương 123: Tên"
 * hoặc "Hồi 123: Tên" (số chương lấy nguyên từ tiêu đề thật, không tự sinh theo thứ tự crawl).
 * Không khớp được thì trả về null -> dùng nguyên tiêu đề trong 1 thẻ <h2> đơn giản.
 */
function splitTitle(rawTitle) {
  if (!rawTitle) return null;
  const m = rawTitle.match(/^\s*((?:ch[uư][ơo]ng|h[oồ]i)\s*\d+)\s*[:\-–]\s*(.+?)\s*$/i);
  if (!m) return null;
  const rest = m[2].trim();
  if (!rest) return null;
  return { num: m[1].trim(), title: rest };
}

function escapeXml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

// XHTML (dùng cho nội dung chương trong epub) yêu cầu XML CHẶT CHẼ hơn HTML thường: mọi thẻ
// "void" (không có nội dung con) như <br>, <img>, <hr>... PHẢI tự đóng dạng <br/>. Nội dung
// chương lấy từ trang gốc (qua cheerio ở crawler.js) không tự đảm bảo điều này — nếu bỏ qua
// bước này, nhiều reader/epubcheck coi file xhtml là "không well-formed" và có thể từ chối
// hiển thị hoặc báo lỗi khi validate.
const VOID_ELEMENTS = ['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr'];
const VOID_TAG_RE = new RegExp(`<(${VOID_ELEMENTS.join('|')})((?:\\s+[^<>]*?)?)\\s*/?>`, 'gi');

function selfCloseVoidElements(html) {
  return String(html || '').replace(VOID_TAG_RE, (_match, tag, attrs) => {
    const a = (attrs || '').trim();
    return `<${tag}${a ? ' ' + a : ''}/>`;
  });
}

// XML CHỈ hiểu đúng 5 entity: &amp; &lt; &gt; &quot; &apos; — mọi entity "đặt tên" khác
// của HTML (như &nbsp;, &mdash;, &rsquo;...) đều KHÔNG hợp lệ trong XML/XHTML dù trình
// duyệt thường vẫn hiển thị đúng. Nội dung crawl từ web thường có sẵn &nbsp; (dấu cách
// không ngắt dòng) hoặc các dấu ngoặc/gạch ngang kiểu chữ dưới dạng entity gốc của trang —
// nếu ghi thẳng vào .xhtml sẽ bị parser XML báo lỗi "entity not found" (đúng như log thấy).
// -> đổi sang numeric character reference (&#160; ...), LUÔN hợp lệ trong XML bất kể tên gì.
const HTML_NAMED_ENTITY_MAP = {
  nbsp: '160', ensp: '8194', emsp: '8195', thinsp: '8201',
  mdash: '8212', ndash: '8211', hellip: '8230',
  lsquo: '8216', rsquo: '8217', ldquo: '8220', rdquo: '8221',
  laquo: '171', raquo: '187',
  copy: '169', reg: '174', trade: '8482', deg: '176',
  times: '215', divide: '247', plusmn: '177', middot: '183',
  bull: '8226', dagger: '8224', Dagger: '8225', permil: '8240',
  euro: '8364', pound: '163', yen: '165', cent: '162',
  sect: '167', para: '182', shy: '173',
};
const XML_BUILTIN_ENTITIES = new Set(['amp', 'lt', 'gt', 'quot', 'apos']);

function fixNonXmlEntities(html) {
  return String(html || '').replace(/&([a-zA-Z][a-zA-Z0-9]*);/g, (match, name) => {
    if (XML_BUILTIN_ENTITIES.has(name)) return match; // đã hợp lệ trong XML -> giữ nguyên
    const code = HTML_NAMED_ENTITY_MAP[name];
    if (code) return `&#${code};`;
    // Entity lạ không có trong bảng -> không đoán bừa; escape dấu & để ít nhất không làm
    // vỡ cấu trúc XML (hiển thị ra chữ "&tenentity;" thay vì đúng ký tự, còn hơn hỏng cả file).
    console.warn(`[epubBuilder] Gặp HTML entity lạ "&${name};" chưa có trong bảng quy đổi -> giữ dạng chữ để không vỡ XML`);
    return `&amp;${name};`;
  });
}

function buildChapterBodyHtml(index, title, bodyHtml) {
  const parsed = splitTitle(title);
  const heading = parsed
    ? `<h2><span class="ch-num">${escapeXml(parsed.num)}</span><span class="sep">: </span><span class="ch-title">${escapeXml(
      parsed.title
    )}</span></h2>`
    : `<h2>${escapeXml(title || `Chương ${index}`)}</h2>`;
  const safeBody = selfCloseVoidElements(fixNonXmlEntities(bodyHtml));
  return `${heading}\n${safeBody}`;
}

/** Đoán mime/extension từ content-type header, fallback theo đuôi file trong URL. */
function guessImageType(url, contentType) {
  const ct = (contentType || '').split(';')[0].trim().toLowerCase();
  const table = {
    'image/png': 'png',
    'image/jpeg': 'jpg',
    'image/jpg': 'jpg',
    'image/webp': 'webp',
    'image/gif': 'gif',
  };
  if (table[ct]) return { ext: table[ct], mime: ct === 'image/jpg' ? 'image/jpeg' : ct };
  const m = (url || '').split('?')[0].match(/\.(\w+)$/);
  const e = m ? m[1].toLowerCase() : '';
  if (e === 'png') return { ext: 'png', mime: 'image/png' };
  if (e === 'webp') return { ext: 'webp', mime: 'image/webp' };
  if (e === 'gif') return { ext: 'gif', mime: 'image/gif' };
  return { ext: 'jpg', mime: 'image/jpeg' };
}

/**
 * Tải ảnh bìa (nếu có URL) — đây là ảnh METADATA của sách (1 tấm duy nhất), không phải nội
 * dung chương, nên vẫn giữ lại dù đã bỏ tính năng nhúng ảnh trong chương. Lỗi thì bỏ qua bìa,
 * không làm hỏng cả job.
 */
async function fetchCover(coverUrl) {
  if (!coverUrl) return null;
  try {
    const res = await axios.get(coverUrl, { responseType: 'arraybuffer', timeout: 15000, maxRedirects: 5 });
    const { ext, mime } = guessImageType(coverUrl, res.headers['content-type']);
    return { buf: Buffer.from(res.data), ext, mime };
  } catch (err) {
    console.warn(`[epubBuilder] Không tải được ảnh bìa (${coverUrl}): ${err.message} -> bỏ qua bìa`);
    return null;
  }
}

/**
 * Validate 1 tài liệu XML/XHTML bằng parser thật (không phải regex đoán mò) — bắt được các
 * lỗi kiểu thẻ không đóng, ký tự "&"/"<" chưa escape lọt ra ngoài, mismatched tag... Trả về
 * mảng issue (rỗng nếu file hợp lệ). Không throw ra ngoài — chỉ validate để CẢNH BÁO, epub
 * vẫn được ghi ra bình thường vì nhiều reader (Calibre, Kindle...) khá dễ tính, chỉ cần biết
 * trước là có khả năng lỗi ở đâu.
 */
function validateXml(filePath, xmlString) {
  const issues = [];
  const parser = new DOMParser({
    locator: {},
    errorHandler: {
      warning: () => { }, // whitespace/encoding warning vặt vãnh -> bỏ qua, không hữu ích
      error: (msg) => issues.push(String(msg).split('\n')[0]),
      fatalError: (msg) => issues.push(String(msg).split('\n')[0]),
    },
  });
  parser.parseFromString(xmlString, 'application/xml');
  return issues.map((msg) => ({ file: filePath, message: msg }));
}

/**
 * Validate toàn bộ các tài liệu XML của epub (content.opf, toc.ncx, nav.xhtml, cover.xhtml,
 * mọi chapterN.xhtml) NGAY TRƯỚC KHI ghi file .epub ra đĩa. In cảnh báo rõ ràng ra console
 * nếu có vấn đề, kèm trả về danh sách issue để nơi gọi (server.js) có thể hiển thị cho người
 * dùng biết nếu muốn, thay vì phải tự mở epubcheck ngoài để dò.
 */
function validateDocuments(docs) {
  const allIssues = [];
  for (const [filePath, content] of docs) {
    const issues = validateXml(filePath, content);
    allIssues.push(...issues);
  }
  if (allIssues.length > 0) {
    console.warn(`[epubBuilder] ⚠ Phát hiện ${allIssues.length} vấn đề XML khi validate epub (epub vẫn được tạo ra, nhưng có thể hiển thị sai ở vài reader kén chọn):`);
    for (const issue of allIssues.slice(0, 30)) {
      console.warn(`  - ${issue.file}: ${issue.message}`);
    }
    if (allIssues.length > 30) console.warn(`  ... và ${allIssues.length - 30} vấn đề khác (đã ẩn bớt để đỡ rối log)`);
  } else {
    console.log('[epubBuilder] ✓ Validate XML: tất cả tài liệu (opf/ncx/nav/xhtml) đều well-formed.');
  }
  return allIssues;
}

/**
 * Đóng gói danh sách chương thành file .epub (EPUB3, có kèm toc.ncx cho tương thích EPUB2 /
 * Kindle qua chuyển đổi). Không dùng epub-gen — build trực tiếp bằng jszip để kiểm soát đầy
 * đủ manifest/spine, tránh bug làm rớt chương khỏi spine.
 *
 * - MỌI chương luôn nằm trong <spine> theo thứ tự -> Calibre không xếp nhầm "Miscellaneous",
 *   và luôn quét được heading để tự build mục lục nếu người dùng muốn.
 * - nav.xhtml (mục lục điều hướng) + toc.ncx vẫn được sinh đầy đủ, hợp lệ, NHƯNG không nằm
 *   trong <spine> -> mở sách đi thẳng vào bìa/chương 1, không phải bấm qua trang mục lục.
 * - Trước khi ghi file: validate lại toàn bộ tài liệu XML, cảnh báo nếu có vấn đề.
 *
 * Trả về { outputPath, validationIssues } thay vì chỉ outputPath như trước, để nơi gọi biết
 * epub có "sạch" hay không nếu muốn hiển thị cho người dùng.
 */
async function buildEpub({ title, author, cover, chapters, outputPath, lang = 'vi', customCss }) {
  if (!chapters || chapters.length === 0) throw new Error('Không có chương nào để đóng gói epub');

  const zip = new JSZip();
  const bookTitle = title || 'Untitled';
  const bookAuthor = author || 'Unknown';
  const bookUuid = `urn:uuid:${crypto.randomUUID()}`;
  const css = customCss && customCss.trim() ? customCss : DEFAULT_CSS;
  const docsToValidate = []; // [filePath, xmlString][] — gom lại để validate 1 lượt ở cuối

  // mimetype PHẢI là entry đầu tiên và KHÔNG nén — 1 số reader kiểm tra thẳng theo offset.
  zip.file('mimetype', 'application/epub+zip', { compression: 'STORE' });

  const containerXml = `<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>
`;
  zip.file('META-INF/container.xml', containerXml);
  docsToValidate.push(['META-INF/container.xml', containerXml]);

  zip.file('OEBPS/style.css', css);

  // ---- Bìa ----
  let coverInfo = null;
  const coverImg = await fetchCover(cover);
  if (coverImg) {
    const coverFile = `cover.${coverImg.ext}`;
    zip.file(`OEBPS/${coverFile}`, coverImg.buf);
    const coverXhtml = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml">
<head><meta charset="utf-8"/><title>Cover</title>
<style>html,body{margin:0;padding:0;text-align:center;} img{max-width:100%;max-height:100vh;}</style>
</head>
<body><img src="${coverFile}" alt="Cover"/></body>
</html>
`;
    zip.file('OEBPS/cover.xhtml', coverXhtml);
    docsToValidate.push(['OEBPS/cover.xhtml', coverXhtml]);
    coverInfo = { file: coverFile, mime: coverImg.mime };
  }

  // ---- Manifest & spine ----
  const manifestItems = [];
  const spineItems = [];

  if (coverInfo) {
    manifestItems.push(`<item id="cover-image" href="${coverInfo.file}" media-type="${coverInfo.mime}" properties="cover-image"/>`);
    manifestItems.push(`<item id="cover-page" href="cover.xhtml" media-type="application/xhtml+xml"/>`);
    spineItems.push(`<itemref idref="cover-page" linear="yes"/>`);
  }

  chapters.forEach((c, i) => {
    const n = i + 1;
    const id = `chap${n}`;
    const filename = `chapter${n}.xhtml`;
    const bodyHtml = buildChapterBodyHtml(n, c.title, c.data);
    const xhtml = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml">
<head>
<meta charset="utf-8"/>
<title>${escapeXml(c.title || `Chương ${n}`)}</title>
<link rel="stylesheet" type="text/css" href="style.css"/>
</head>
<body>
${bodyHtml}
</body>
</html>
`;
    zip.file(`OEBPS/${filename}`, xhtml);
    docsToValidate.push([`OEBPS/${filename}`, xhtml]);
    manifestItems.push(`<item id="${id}" href="${filename}" media-type="application/xhtml+xml"/>`);
    // linear="yes" + luôn có mặt trong spine theo đúng thứ tự -> đây chính là điểm khác biệt
    // so với epub-gen cũ (nơi excludeFromToc vô tình xoá luôn itemref này).
    spineItems.push(`<itemref idref="${id}" linear="yes"/>`);
  });

  // ---- nav.xhtml (mục lục điều hướng chuẩn EPUB3) — CHỦ Ý không đưa vào <spine> để mở
  // sách không bị dẫn qua trang này trước; reader vẫn tự lấy nav này làm menu "Mục lục". ----
  const navLis = chapters
    .map((c, i) => `      <li><a href="chapter${i + 1}.xhtml">${escapeXml(c.title || `Chương ${i + 1}`)}</a></li>`)
    .join('\n');
  const navXhtml = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
<head><meta charset="utf-8"/><title>Mục lục</title></head>
<body>
  <nav epub:type="toc" id="toc">
    <h1>Mục lục</h1>
    <ol>
${navLis}
    </ol>
  </nav>
</body>
</html>
`;
  zip.file('OEBPS/nav.xhtml', navXhtml);
  docsToValidate.push(['OEBPS/nav.xhtml', navXhtml]);
  manifestItems.push(`<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>`);

  // ---- toc.ncx (EPUB2 / Kindle fallback — cũng KHÔNG nằm trong spine, chỉ để reader tự
  // build menu điều hướng nếu cần, giữ tương thích ngược cho các máy đọc cũ) ----
  const navPoints = chapters
    .map(
      (c, i) => `    <navPoint id="navPoint-${i + 1}" playOrder="${i + 1}">
      <navLabel><text>${escapeXml(c.title || `Chương ${i + 1}`)}</text></navLabel>
      <content src="chapter${i + 1}.xhtml"/>
    </navPoint>`
    )
    .join('\n');
  const tocNcx = `<?xml version="1.0" encoding="UTF-8"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">
  <head>
    <meta name="dtb:uid" content="${bookUuid}"/>
    <meta name="dtb:depth" content="1"/>
    <meta name="dtb:totalPageCount" content="0"/>
    <meta name="dtb:maxPageDepth" content="0"/>
  </head>
  <docTitle><text>${escapeXml(bookTitle)}</text></docTitle>
  <navMap>
${navPoints}
  </navMap>
</ncx>
`;
  zip.file('OEBPS/toc.ncx', tocNcx);
  docsToValidate.push(['OEBPS/toc.ncx', tocNcx]);
  manifestItems.push(`<item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>`);
  manifestItems.push(`<item id="css" href="style.css" media-type="text/css"/>`);

  const metaCover = coverInfo ? `\n    <meta name="cover" content="cover-image"/>` : '';
  const modified = new Date().toISOString().replace(/\.\d+Z$/, 'Z');

  const contentOpf = `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="BookId">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="BookId">${bookUuid}</dc:identifier>
    <dc:title>${escapeXml(bookTitle)}</dc:title>
    <dc:creator>${escapeXml(bookAuthor)}</dc:creator>
    <dc:language>${lang}</dc:language>
    <meta property="dcterms:modified">${modified}</meta>${metaCover}
  </metadata>
  <manifest>
${manifestItems.map((m) => `    ${m}`).join('\n')}
  </manifest>
  <spine toc="ncx">
${spineItems.map((s) => `    ${s}`).join('\n')}
  </spine>
</package>
`;
  zip.file('OEBPS/content.opf', contentOpf);
  docsToValidate.push(['OEBPS/content.opf', contentOpf]);

  // ---- Validate TRƯỚC KHI ghi ra đĩa (chỉ cảnh báo, không chặn tạo file) ----
  const validationIssues = validateDocuments(docsToValidate);

  const buf = await zip.generateAsync({ type: 'nodebuffer', mimeType: 'application/epub+zip', compression: 'DEFLATE' });
  fs.writeFileSync(outputPath, buf);
  return { outputPath, validationIssues };
}

module.exports = { buildEpub, DEFAULT_CSS };