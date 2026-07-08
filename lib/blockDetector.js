// Nhận diện 2 loại trang "không phải nội dung thật" dù server trả về status 200 bình thường.
// Tách riêng 2 hàm vì xử lý khác nhau:
//  - detectBotBlock: chặn TOÀN TRANG (Cloudflare, DDoS-Guard, captcha...) -> DỪNG HẲN ngay,
//    không nên retry (retry chỉ tốn thời gian, có khi còn bị chặn nặng hơn).
//  - detectPaywall: chỉ CHƯƠNG NÀY yêu cầu đăng nhập/VIP -> BỎ QUA chương này, crawl tiếp.

const BOT_BLOCK_PATTERNS = [
  /just a moment/i,
  /checking your browser/i,
  /attention required[\s\S]{0,50}cloudflare/i,
  /cf-browser-verification/i,
  /ddos-?guard/i,
  /verify you are human/i,
  /please enable cookies/i,
  /unusual traffic from your (computer|network)/i,
  /captcha/i,
  /access denied/i,
  /perimeterx/i,
];

const PAYWALL_PATTERNS = [
  /vui\s*lòng\s*đăng\s*nhập/i,
  /đăng\s*nhập\s*để\s*(đọc|xem)/i,
  /nạp\s*vip/i,
  /mua\s*vip/i,
  /chương\s*vip/i,
  /nội\s*dung\s*(này\s*)?dành\s*cho\s*(thành\s*viên\s*)?vip/i,
  /vui\s*lòng\s*mua\s*chương/i,
  /chương\s*này\s*yêu\s*cầu/i,
];

/** Kiểm tra trên HTML thô (không phụ thuộc contentSelector) — dùng ngay ở tầng fetch. */
function detectBotBlock(html) {
  const sample = (html || '').slice(0, 6000);
  for (const re of BOT_BLOCK_PATTERNS) {
    if (re.test(sample)) return { type: 'bot-block', matched: re.source };
  }
  return null;
}

/** Kiểm tra trên TEXT đã trích xuất theo contentSelector — dùng ở tầng crawler (per-chương). */
function detectPaywall(contentText) {
  const sample = (contentText || '').slice(0, 2000);
  for (const re of PAYWALL_PATTERNS) {
    if (re.test(sample)) return { type: 'paywall', matched: re.source };
  }
  return null;
}

module.exports = { detectBotBlock, detectPaywall };
