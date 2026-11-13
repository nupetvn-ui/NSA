# ADR-0014: Bài mở app tự động trên CI Windows (G2)

- Trạng thái: Chấp nhận
- Ngày: 2026-11-13

## Bối cảnh

Lỗi màn hình đen sau PR #5 (một `import … from 'node:os'` trong giao diện) lọt qua CI vì CI chỉ chạy lint, typecheck và test trên Linux: không có bước nào dựng app rồi mở nó. Giao diện (~4.300 dòng) không có test; `renderer-imports.test.ts` chỉ canh một loại lỗi. Lỗi này còn đặc biệt ở chỗ **chỉ nổ ở chế độ dev** (Vite nạp từng mô-đun nguyên vẹn); bản build bỏ được mã không dùng nên che lỗi.

## Quyết định

**Công cụ: `playwright-core` (`_electron.launch`) chạy dưới Vitest**, không dùng `@playwright/test`.

- Cần đúng một thứ của Playwright: điều khiển cửa sổ Electron thật (bấm, gõ, đọc console / lỗi không bắt). `playwright-core` không kéo trình duyệt nào về (Electron tự mang Chromium).
- Vitest đã là bộ chạy test của repo: không thêm bộ chạy thứ hai, dùng chung cách viết `describe/it/expect`. Bài nằm ở `apps/desktop/e2e/` với cấu hình riêng `vitest.e2e.config.ts` nên **không** chạy trong `pnpm test` (cần dựng app và mở cửa sổ). Chạy bằng `pnpm --filter @nsa/desktop test:e2e`.
- Đã cân nhắc Spectron (đã ngừng), WebdriverIO (nặng hơn, cần chromedriver khớp bản Electron), Puppeteer (điều khiển Electron kém ổn định).

**Không cần CLI thật hay key.** Khi đặt `NSA_E2E_FAKE_AGENT=1`, `createAgents` trả duy nhất một agent giả (`apps/desktop/src/main/e2e-agent.ts`, trả lời cố định) thay cho danh sách thật; `NSA_USER_DATA` trỏ vào thư mục tạm nên không đụng dữ liệu người dùng. Hộp chọn thư mục của hệ điều hành được thay bằng một thư mục tạm qua `dialog.showOpenDialog` trong tiến trình chính.

**Bài đi qua:** khung chính → chọn thư mục + agent giả → gửi một câu và thấy câu trả lời → Bộ nhớ (bấm từng thẻ) → Nhà cung cấp (bấm từng thẻ) → App Store → quay lại cuộc trò chuyện. Mọi `console.error` và `pageerror` của giao diện (kể cả lúc nạp trang: trang được nạp lại một lần sau khi gắn bộ nghe) làm bài thất bại. `bail: 1`: bước hỏng thì dừng ngay.

**Ba đích, chọn bằng `NSA_E2E_TARGET`:**

| Đích             | Giao diện nạp từ                     | Bắt được                                                                                     |
| ---------------- | ------------------------------------ | -------------------------------------------------------------------------------------------- |
| `dev` (mặc định) | máy chủ Vite dev dựng ngay trong bài | lỗi import `node:*` trong giao diện (đường đã gây màn hình đen)                              |
| `build`          | `out/renderer` (nạp file)            | lỗi chỉ có ở bản build; main/preload dựng được                                               |
| `packaged`       | `release/<ver>/win-unpacked/NSA.exe` | thiếu nhị phân gốc (node-pty…), file bị `asar` che, sai đường dẫn tài nguyên khi đã đóng gói |

Bản build (`out/`) một mình **không** bắt được lỗi `node:os` (Rollup bỏ import không dùng), nên CI có thêm bước coi dòng cảnh báo "externalized for browser compatibility" của Vite khi dựng là lỗi.

**CI:** job `e2e` trong `ci.yml` chạy trên `windows-latest`, mỗi push và PR: cài → tải nhị phân Electron (pnpm chặn script cài của electron) → dựng → bài `dev` → bài `build` → `pnpm dist:dir` (đóng gói không ký, thư mục `win-unpacked`, không tạo bộ cài NSIS) → bài `packaged`. Đo ở máy dev: đóng gói ~15 giây, mỗi lượt bài ~5 giây, nên chạy cả ba đích ở mọi PR; không cần tách sang chạy theo lịch.

**Workflow hằng đêm** (`contract-nightly.yml`) đã được bấm chạy và sửa tới khi xanh — xem phần "Kết quả" bên dưới.

## Hệ quả

- Lỗi kiểu màn hình đen, thiếu nhị phân gốc, lỗi console khi mở các màn hình chính làm CI đỏ trước khi merge.
- Bài **chưa** kiểm: nội dung nghiệp vụ trong từng màn hình (nhập key, cài plugin…), CLI thật, bản có ký mã, cập nhật tự động. Chúng thuộc các test khác hoặc việc về sau.
- Có thêm một biến môi trường test (`NSA_E2E_FAKE_AGENT`) trong mã chạy thật; nó chỉ làm danh sách agent chỉ còn agent giả, không mở quyền nào.
- Thêm phụ thuộc dev `playwright-core`.

## Kết quả
