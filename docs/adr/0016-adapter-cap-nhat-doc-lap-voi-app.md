# ADR-0016: Adapter và file dữ liệu hãng cập nhật độc lập với app (G1)

- Trạng thái: Chấp nhận
- Ngày: 2026-11-14

## Bối cảnh

Nguyên tắc 2 của `docs/PLAN.md` chưa thành hiện thực: adapter được biên dịch cứng vào app, file dữ liệu hãng/model chỉ đọc bản cục bộ. Mỗi lần một CLI đổi định dạng vẫn phải ra bản app mới. ADR-0015 đã gỡ các phụ thuộc ngược để việc này khả thi.

## Quyết định

**Dùng lại cơ chế gói của plugin, không dựng cơ chế mới.** Adapter và file dữ liệu được đóng thành `.nsapkg` (cùng định dạng, cùng chữ ký Ed25519, cùng `verifyPackage` / `readPackage` / `extractFiles` của `packages/plugin-host/src/pack.ts`; thêm hàm `packFiles` không kiểm manifest plugin) và cùng kiểm phiên bản tương thích (trường `nsa` + `satisfies` của plugin-sdk). Chỉ thêm manifest riêng `adapter.json` (`kind: adapter | catalog`, `id`, `version`, `nsa`, `entry`, `contract`). Mã nằm ở gói mới `@nsa/adapter-host`.

**Bản kèm app là bản dự phòng.** Bản tải về chỉ được chọn khi: ký bằng khoá của NSA, `nsa` hợp phiên bản app, phiên bản **mới hơn** bản kèm app và bản đang dùng (không hạ cấp), nạp được, và qua test hợp đồng tối thiểu (đúng mã, đủ hàm, bảng năng lực đúng dạng; khi cài còn chạy thật `detect()` trong thời hạn). Trượt bất kỳ bước nào ở lúc cài: gói bị từ chối, xoá, không bao giờ thành bản chạy. Hỏng sau khi đã cài (file hỏng lúc mở app, `createAdapter()` ném lỗi lúc dùng, app mới không còn tương thích): tự quay về bản kèm app, ghi nhớ phiên bản hỏng để không thử lại, **báo người dùng** (băng thông báo "Adapter agent") và ghi `AuditLog` (`adapter_update`: `installed | rejected | fallback | catalog`).

**Adapter chạy ở đâu: trong tiến trình chính của app**, nạp bằng `require` một file CommonJS tự đủ (đóng bằng Vite, `node-pty` được nạp từ chính app qua `globalThis.nsaHostRequire`). Lý do: `AgentAdapter` là giao diện đầy hàm gọi lại, luồng sự kiện và tiến trình con; đưa sang tiến trình riêng cần dựng lớp chuyển tiếp cho mọi thứ đó và không cho thêm bảo vệ thật (adapter vốn phải chạy chương trình CLI và đọc ghi thư mục làm việc, quyền ngang app). Việc tải mã về chạy được bảo vệ bằng chữ ký chứ không bằng cô lập. Hệ quả cần nói thẳng: **nếu khoá ký của NSA bị lộ, kẻ giữ khoá chạy được mã tuỳ ý trên máy mọi người dùng** — ngang rủi ro khoá ký bản app. Giảm thiểu: chỉ nhận khoá đóng cùng app (`resources/adapter-trust.json`, không lấy từ chỉ mục hay thư mục dữ liệu); không có chế độ cài adapter chưa ký ngoài chế độ nhà phát triển (`NSA_ADAPTER_ALLOW_UNSIGNED=1`, chỉ khi app chưa đóng gói; gói bị sửa vẫn luôn bị từ chối); chống hạ cấp; chỉ mục không được tin (mã băm trong chỉ mục chỉ là kiểm toàn vẹn); https bắt buộc (http chỉ trên máy này); khoá riêng chỉ nằm trong secret của CI. Lớp cô lập cho mã bên thứ ba là việc của G4, chưa làm ở đây.

**Khoá của NSA** (tạo 14/11/2026 theo yêu cầu của chủ dự án): khoá công khai nằm trong `resources/adapter-trust.json`; khoá riêng KHÔNG ở trong repo — chỉ ở máy chủ dự án (`~/.nsa-keys/adapter-signing.pem`) và (khi được đặt) secret `NSA_ADAPTER_SIGNING_KEY`. Để trống `keys` thì app không tự cập nhật.

**File dữ liệu hãng/model theo cùng kênh.** Gói `provider-catalog` (kind `catalog`) qua cùng bước kiểm chữ ký / tương thích / mới hơn, rồi `validateCatalog` của providers; hợp lệ thì ghi `provider-catalog.json` trong thư mục dữ liệu (nơi `pickCatalog` vốn đã đọc). Áp dụng ở lần mở app kế tiếp.

**Nguồn tải** là một file chỉ mục sau interface `AdapterSource` (`IndexAdapterSource`: URL https hoặc đường dẫn máy). Địa chỉ cấu hình được: biến `NSA_ADAPTER_INDEX_URL`, hoặc `adapter-source.json` (`{ "indexUrl": … }`) trong thư mục dữ liệu; mặc định `https://github.com/nupetvn-ui/NSA/releases/download/adapters/index.json` (một release cố định tên `adapters` trên GitHub). Kho riêng của doanh nghiệp cắm vào cùng interface.

**Phát hành tách khỏi app:** workflow `release-adapters.yml` (chạy tay) dựng gói, ký bằng secret, sinh chỉ mục và đưa lên artifact. **Không tự tạo tag hay release**; đăng lên release `adapters` đã có là bước tuỳ chọn, tắt mặc định. Công cụ: `pnpm adapters:pack`, `pnpm adapters:keygen`.

**Lịch kiểm tra:** 5 giây sau khi mở app rồi mỗi 6 giờ; lỗi mạng / chưa có bản phát hành thì im lặng. Có bản mới thì dựng lại danh sách agent ngay (không cần khởi động lại). Cặp "CLI + key hãng" dùng adapter lúc tạo, nên nhận bản mới ở lần mở app kế tiếp.

## Hệ quả

- Đổi định dạng CLI chỉ cần phát hành gói adapter; phiên bản gói = `version` trong `package.json` của adapter (đã đặt 0.1.0), bản kèm app và bản phát hành cùng một nguồn.
- Tiến trình chính nay nạp mã từ thư mục dữ liệu: bề mặt tấn công mới là khoá ký (xem trên).
- `adapter-pty` nạp `node-pty` qua `globalThis.nsaHostRequire` nếu có (chỉ để adapter tải về dùng được module native của app).

## Kết quả kiểm (2026-11-14)

- `packages/adapter-host/src/manager.test.ts` (20 test): cài gói ký đúng; không hạ cấp; gói bị sửa sau khi ký, chưa ký, ký bằng khoá lạ, sai mã băm, không tương thích, nạp lỗi, trượt hợp đồng đều bị từ chối; bản đã cài hỏng → về bản kèm app + thông báo + nhật ký + không thử lại; `createAdapter()` ném lỗi lúc dùng; file dữ liệu; nguồn qua HTTP cục bộ, từ chối http ngoài máy.
- `apps/desktop/e2e/adapter-update.e2e.test.ts`: app thật + máy chủ chỉ mục cục bộ, **chạy ở cả dev, build và bản đóng gói**: phát hành adapter Claude 0.1.1 (đổi tên hiển thị) → app đang chạy nhận và dùng, mở lại vẫn dùng; làm hỏng file đã tải → quay về bản kèm app, báo người dùng, có `fallback` trong nhật ký; gói hỏng → từ chối; gói sửa sau khi ký → từ chối. Với bản đóng gói, khoá tin cậy kèm app được thay bằng khoá thử (giống bản dựng có khoá thật).

## Chưa làm / chưa chạy thật

- **Chưa tải từ GitHub Releases thật**: chưa có release `adapters`, chưa có khoá của NSA, workflow `release-adapters.yml` chưa chạy lần nào.
- Gói thật chưa thử với CLI thật qua bản tải về (bài thử dùng bản đóng của chính adapter Claude với tên đổi).
- Cặp CLI + key và file dữ liệu hãng áp dụng ở lần mở sau, chưa nạp nóng.
- Chưa có cô lập tiến trình cho adapter tải về (G4).
