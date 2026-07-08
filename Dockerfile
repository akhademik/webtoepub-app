FROM node:20-slim

# Cài các gói hệ thống Playwright cần để chạy Chromium headless (fonts, libnss, libatk...).
# Dùng node:20-slim (không phải node:20-alpine) vì Playwright/Chromium không hỗ trợ tốt
# trên musl libc của Alpine.
WORKDIR /app

# Copy trước package*.json để tận dụng Docker layer cache — chỉ chạy lại npm ci khi
# package.json/package-lock.json thay đổi, không phải mỗi lần sửa code.
COPY package.json package-lock.json ./

# npm ci (không phải npm install) để build tái lập đúng y hệt lockfile.
# --omit=dev vì project không có devDependencies riêng, nhưng để rõ ràng ý định "production".
RUN npm ci --omit=dev

# Cài Chromium + toàn bộ thư viện hệ thống nó cần (--with-deps) NGAY SAU khi cài package
# playwright, để chắc chắn version Chromium khớp với version playwright vừa npm ci (khác
# với việc dùng base image mcr.microsoft.com/playwright cố định sẵn 1 version, dễ lệch nếu
# package.json update). Bỏ qua postinstall check thủ công vì bước này làm luôn rồi.
RUN npx playwright install --with-deps chromium

# Copy phần code còn lại (sau khi đã cài dependency, để code đổi không làm invalidate cache ở trên)
COPY . .

# Thư mục output/ (epub đã đóng gói + tiến độ crawl từng sách) và data/ (providers.json đã
# lưu) cần PERSIST qua các lần container restart/recreate -> mount volume vào đây khi chạy
# (xem docker-compose.yml / hướng dẫn "docker run -v" đi kèm). Tạo sẵn thư mục để tránh lỗi
# quyền ghi nếu volume mount vào 1 thư mục chưa tồn tại trên 1 số Docker version.
RUN mkdir -p /app/output /app/data

ENV NODE_ENV=production
ENV PORT=3000
EXPOSE 3000

# Chạy bằng user không phải root cho an toàn hơn — image node chính thức có sẵn user "node".
# Cần chown lại output/data vì đã tạo bằng root ở bước trên.
RUN chown -R node:node /app/output /app/data
USER node

CMD ["node", "server.js"]