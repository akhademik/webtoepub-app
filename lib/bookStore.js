const fs = require('fs');
const path = require('path');

function slugify(str) {
  return String(str || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  // Lưu ý: KHÔNG fallback 'book' ở đây — để bookDirFor() tự quyết định thứ tự ưu tiên
  // (tên sách -> URL -> 'book'), tránh 'book' ở đây che mất khả năng dùng URL làm slug
  // khi tên sách để trống (VD: khi dùng chế độ mục lục để tự điền tên sau).
}

/** Thư mục làm việc riêng cho 1 cuốn sách, dựa theo tên sách (hoặc URL nếu chưa có tên). */
function bookDirFor(outputRoot, bookTitle, startUrl) {
  const slug = slugify(bookTitle) || slugify(startUrl) || 'book';
  return path.join(outputRoot, `_book_${slug}`);
}

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

const metaPath = (bookDir) => path.join(bookDir, 'meta.json');
const configPath = (bookDir) => path.join(bookDir, 'config.json');
const chaptersDir = (bookDir) => path.join(bookDir, 'chapters');

function loadJson(p) {
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, 'utf-8'));
  } catch (err) {
    // Không âm thầm nuốt lỗi: file .json hỏng (vd app bị kill giữa lúc ghi) khiến
    // sách/tiến độ "biến mất" khỏi danh sách mà không rõ lý do nếu không log ra đây.
    console.warn(`[bookStore] Không đọc được ${p} (JSON hỏng?): ${err.message}`);
    return null;
  }
}

function saveMeta(bookDir, meta) {
  ensureDir(bookDir);
  fs.writeFileSync(metaPath(bookDir), JSON.stringify(meta, null, 2));
}
function loadMeta(bookDir) {
  return loadJson(metaPath(bookDir));
}

function saveConfig(bookDir, config) {
  ensureDir(bookDir);
  fs.writeFileSync(configPath(bookDir), JSON.stringify(config, null, 2));
}
function loadConfig(bookDir) {
  return loadJson(configPath(bookDir));
}

function chapterFilePath(bookDir, index) {
  return path.join(chaptersDir(bookDir), `${String(index).padStart(5, '0')}.json`);
}

/** Lưu 1 chương ngay lập tức xuống đĩa — không chờ tới lúc crawl xong toàn bộ mới ghi. */
function saveChapter(bookDir, index, chapter) {
  ensureDir(chaptersDir(bookDir));
  fs.writeFileSync(chapterFilePath(bookDir, index), JSON.stringify(chapter));
}

function loadAllChapters(bookDir) {
  const dir = chaptersDir(bookDir);
  if (!fs.existsSync(dir)) return [];
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort();
  return files.map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf-8')));
}

function countChapters(bookDir) {
  const dir = chaptersDir(bookDir);
  if (!fs.existsSync(dir)) return 0;
  return fs.readdirSync(dir).filter((f) => f.endsWith('.json')).length;
}

/** Xoá sạch thư mục làm việc của 1 cuốn sách sau khi đã đóng gói .epub thành công (tuỳ chọn dọn dẹp). */
function cleanupBookDir(bookDir) {
  if (fs.existsSync(bookDir)) fs.rmSync(bookDir, { recursive: true, force: true });
}

/** Quét toàn bộ thư mục sách (đang dở hoặc đã xong) trong output/ để hiển thị lúc khởi động. */
function listBooks(outputRoot) {
  if (!fs.existsSync(outputRoot)) return [];
  return fs
    .readdirSync(outputRoot)
    .filter((name) => name.startsWith('_book_'))
    .map((slug) => {
      const dir = path.join(outputRoot, slug);
      if (!fs.statSync(dir).isDirectory()) return null;
      const meta = loadMeta(dir);
      if (!meta) return null;
      return { slug, dir, ...meta };
    })
    .filter(Boolean)
    .sort((a, b) => (b.lastUpdated || 0) - (a.lastUpdated || 0));
}

/** Tập các index chương đã lưu trên đĩa — dùng cho resume kiểu song song (TOC mode),
 * nơi thứ tự hoàn thành không tuần tự nên không thể chỉ dựa vào "count" đơn giản. */
function getSavedIndices(bookDir) {
  const dir = chaptersDir(bookDir);
  if (!fs.existsSync(dir)) return new Set();
  return new Set(
    fs
      .readdirSync(dir)
      .filter((f) => f.endsWith('.json'))
      .map((f) => parseInt(f.replace('.json', ''), 10))
  );
}

module.exports = {
  slugify,
  bookDirFor,
  ensureDir,
  saveMeta,
  loadMeta,
  saveConfig,
  loadConfig,
  saveChapter,
  loadAllChapters,
  countChapters,
  cleanupBookDir,
  listBooks,
  getSavedIndices,
};