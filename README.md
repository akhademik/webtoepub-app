# Sổ Đóng Sách — Web → EPUB

Web app tự host: cấu hình CSS selector cho nội dung, tiêu đề chương và nút "chương kế" (hoặc dùng trang mục lục) — app tự crawl toàn bộ truyện và đóng gói thành 1 file `.epub` có mục lục.

## Cài đặt

Yêu cầu Node.js >= 18.

```bash
npm install
npx playwright install chromium
npm start
```

Mở `http://localhost:3000`.

> **Chromium dùng để làm gì?** Cần cho chế độ tải "browser/auto" — nhiều trang JS nặng phải render bằng trình duyệt thật mới lấy được nội dung. Nếu chỉ crawl site HTML tĩnh, có thể bỏ qua và chọn "Chỉ HTML tĩnh" trong app.
>
> **`npm install` không tự cài Chromium cho bạn?** Bản thân `playwright` có tự tải Chromium khi `npm install`, nhưng bước này hay bị bỏ qua (mạng chặn, dùng `--ignore-scripts`, CI giới hạn dung lượng...) mà không báo lỗi rõ ràng. Luôn chạy thêm `npx playwright install chromium` để chắc chắn.
>
> Nếu `npx playwright` báo `not found`, dùng: `node node_modules/playwright/cli.js install chromium`

## Cách dùng

**Bước 1 — Nội dung & xem trước**
1. Chọn mode: **A** (site có trang mục lục đầy đủ) hoặc **B** (chỉ có chương 1 + nút "chương kế").
2. Dán URL, nhập selector nội dung / tiêu đề / selector cần loại bỏ (ads, nút chia sẻ...).
3. Bấm **Test** xem preview, ưng ý thì **Áp dụng & tiếp tục**.

**Bước 2 — Bìa & phạm vi crawl**
1. Mode B: điền tên sách, tác giả, ảnh bìa. Mode A: tự lấy từ trang mục lục.
2. Nhập selector nút "chương kế" (mode B) hoặc URL mục lục + selector link chương (mode A). Dùng nút "Test 5 trang liên tiếp" / "Test mục lục" để kiểm tra trước khi chạy thật.
3. Bấm **Đóng sách EPUB**, theo dõi tiến độ, tải file khi xong.

## Mẹo & tính năng nâng cao

- **XPath cho nút "next"**: gõ `xpath://a[contains(text(),"Tiếp")]` hoặc bắt đầu bằng `//` — hữu ích khi site dùng Tailwind (class trùng nhau giữa nút "Trước"/"Tiếp"). Cần đã cài Chromium.
- **Lưu provider**: đặt tên bộ selector ở bước 2 để lần sau chọn lại từ dropdown, khỏi dò lại từ đầu.
- **Giãn cách request / stealth**: bật ở tuỳ chọn nâng cao nếu site nhạy với tốc độ truy cập.

## Resume & xử lý lỗi

- Mỗi chương lưu ra đĩa ngay khi tải xong. Mất mạng/lỗi tạm thời → tự động thử lại; nếu vẫn lỗi, job chuyển **"Tạm dừng"** — bấm **Đóng sách EPUB** lại (cùng tên sách) để tiếp tục đúng chỗ dừng.
- Trang bị chặn bot (Cloudflare, captcha...) → dừng ngay, không tự thử lại (tránh bị chặn nặng hơn) — cần xử lý thủ công (cookie, VIP, đổi cách tải...).
- 1 chương yêu cầu đăng nhập/VIP → chỉ bỏ qua chương đó, crawl tiếp bình thường.
- Nút **"Dừng"** giữa chừng không mất tiến độ. Màn hình mở app hiện sẵn danh sách sách đang dở/đã xong để tiếp tục hoặc xoá.

## Giới hạn

- Chạy local trên máy bạn, không gửi gì lên server ngoài trừ chính các trang bạn crawl.
- Tôn trọng điều khoản sử dụng và bản quyền của trang nguồn.
- Site chặn theo IP/vùng hoặc chống bot cấp doanh nghiệp thì kể cả browser + stealth cũng có thể vẫn bị chặn.

## Chạy bằng Docker

Cách nhanh nhất nếu không muốn cài Node/Playwright thủ công trên host.

### Chạy image có sẵn (đã build & push tự động qua GitHub Actions)

```bash
docker compose up -d
```

`docker-compose.yml` mặc định trỏ tới `your-dockerhub-username/webtoepub-app:latest` —
**đổi `your-dockerhub-username` thành username Docker Hub thật của bạn** trước khi chạy
(hoặc thành `image: webtoepub-app:latest` + `build: .` nếu muốn build local thay vì kéo từ
Docker Hub).

Thư mục `output/` (sách/epub + tiến độ crawl) và `data/` (provider đã lưu) được mount ra
host để dữ liệu sống sót qua các lần `docker compose down`/`up` hoặc update image.

### Build local thủ công (không qua CI)

```bash
docker build -t webtoepub-app .
docker run -d -p 3000:3000 -v $(pwd)/output:/app/output -v $(pwd)/data:/app/data webtoepub-app
```

### Tự động build & push lên Docker Hub mỗi khi push code (CI/CD)

Repo có sẵn `.github/workflows/docker-publish.yml` — mỗi lần push lên nhánh `master`,
GitHub Actions tự build image (cho cả `linux/amd64` và `linux/arm64`) và push lên Docker Hub
với 2 tag: `latest` và tag theo short commit sha (để rollback nếu cần).

Để bật, cần làm 1 lần:

1. **Tạo Access Token trên Docker Hub**: đăng nhập [hub.docker.com](https://hub.docker.com) →
   avatar góc trên phải → *Account Settings* → *Security* → *New Access Token* → đặt quyền
   *Read & Write* → copy token (chỉ hiện 1 lần).
2. **Thêm secret vào GitHub repo**: vào repo trên GitHub → *Settings* → *Secrets and
   variables* → *Actions* → tab *Secrets* → *New repository secret*, tạo 2 secret:
   - `DOCKERHUB_USERNAME` — username Docker Hub của bạn
   - `DOCKERHUB_TOKEN` — token vừa tạo ở bước 1 (không dùng mật khẩu thật)
3. **(Tuỳ chọn) đổi tên image**: mặc định workflow build ra
   `your-dockerhub-username/webtoepub-app`. Muốn đổi tên khác, vào tab *Variables* (cùng chỗ
   với Secrets ở bước 2) và tạo variable `DOCKERHUB_IMAGE` = `username/ten-image-ban-muon`.
4. Push lên `master` — vào tab *Actions* trên GitHub để xem tiến trình build. Xong thì image
   đã có sẵn trên `https://hub.docker.com/r/<username>/webtoepub-app`.

Sau đó trên host chạy thật, chỉ cần `docker compose pull && docker compose up -d` để lấy
bản mới nhất mỗi khi có update, không cần build lại thủ công.



```
server.js               Express API + quản lý job crawl
lib/fetcher.js           Tải HTML (static/browser/auto), phát hiện bot-block
lib/xpathHelper.js       Hỗ trợ selector dạng XPath cho nút "next"
lib/blockDetector.js     Nhận diện trang chặn bot / yêu cầu VIP
lib/crawler.js           Crawl theo "chương kế" hoặc theo mục lục (song song), retry, giãn cách
lib/bookStore.js         Lưu tiến độ theo từng sách để resume
lib/providerStore.js     Lưu bộ selector đã đặt tên (data/providers.json)
lib/epubBuilder.js       Đóng gói EPUB (jszip, tự dựng spine/nav/ncx, validate XML)
public/                  Giao diện wizard 2 bước (HTML/CSS/JS thuần, không cần build)
Dockerfile               Build image chạy app (Node + Playwright Chromium)
docker-compose.yml       Chạy image (từ Docker Hub hoặc build local) + mount volume output/data
.github/workflows/       CI: tự build & push image lên Docker Hub khi push master
```