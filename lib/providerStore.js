const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const FILE = path.join(DATA_DIR, 'providers.json');

function ensureDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function loadAll() {
  if (!fs.existsSync(FILE)) return {};
  try {
    return JSON.parse(fs.readFileSync(FILE, 'utf-8'));
  } catch (err) {
    // Không âm thầm nuốt lỗi: nếu providers.json bị hỏng, người dùng sẽ tưởng nhầm là
    // "mất hết provider đã lưu" mà không có manh mối gì để biết vì sao -> log rõ ra.
    console.warn(`[providerStore] Không đọc được ${FILE} (JSON hỏng?): ${err.message}`);
    return {};
  }
}

function saveAll(data) {
  ensureDir();
  fs.writeFileSync(FILE, JSON.stringify(data, null, 2));
}

/** Danh sách rút gọn để hiển thị trong dropdown (không cần gửi hết chi tiết selector). */
function list() {
  const all = loadAll();
  return Object.entries(all)
    .map(([name, p]) => ({ name, domain: p.domain || null, updatedAt: p.updatedAt || null }))
    .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
}

function get(name) {
  const all = loadAll();
  return all[name] || null;
}

function upsert(name, config) {
  if (!name || !name.trim()) throw new Error('Thiếu tên provider');
  const all = loadAll();
  all[name.trim()] = { ...config, updatedAt: Date.now() };
  saveAll(all);
  return all[name.trim()];
}

function remove(name) {
  const all = loadAll();
  if (all[name]) {
    delete all[name];
    saveAll(all);
    return true;
  }
  return false;
}

module.exports = { list, get, upsert, remove };