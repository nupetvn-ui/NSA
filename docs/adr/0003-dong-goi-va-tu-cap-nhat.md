# ADR-0003: Đóng gói NSIS, tự cập nhật qua GitHub Releases, ký mã qua biến môi trường

- Trạng thái: Chấp nhận
- Ngày: 2026-11-11

## Bối cảnh

NSA là sản phẩm thương mại cho Windows trước (macOS ở giai đoạn 8). Người dùng phải cài được bằng một file `.exe` và nhận bản vá mà không phải tải lại thủ công.

## Quyết định

- **electron-builder**, đích **NSIS** x64, cài theo người dùng (không cần quyền admin), cho chọn thư mục cài. Cấu hình ở `apps/desktop/electron-builder.yml`.
- **electron-updater** với provider `github` (`nupetvn-ui/NSA`). Bản đã đóng gói kiểm tra bản mới khi khởi động, tải ở nền, cài khi thoát app. Khi dev thì tắt; đặt `NSA_DISABLE_AUTO_UPDATE=1` để tắt cả ở bản đóng gói.
- **Phát hành**: workflow `release.yml` chạy khi gắn tag `v*` khớp version của app, build trên `windows-latest` và đăng lên GitHub Releases ở dạng **nháp**. Người duyệt bấm Publish thì máy người dùng mới thấy bản cập nhật — tránh phát hành nhầm.
- **Ký mã**: electron-builder tự đọc `CSC_LINK` / `CSC_KEY_PASSWORD` (trên CI lấy từ secret `WIN_CSC_LINK` / `WIN_CSC_KEY_PASSWORD`). Không có thì bỏ qua ký, build vẫn chạy.
  - Lựa chọn sau này: chứng chỉ OV/EV dạng file, hoặc Azure Trusted Signing (thêm `azureSignOptions` vào `win`). Chưa chọn vì chưa có pháp nhân/chứng chỉ.

## Hệ quả

- Bản chưa ký sẽ bị Windows SmartScreen cảnh báo khi cài; chấp nhận được cho giai đoạn nội bộ, bắt buộc phải ký trước khi bán (giai đoạn 8).
- Repo phải công khai, hoặc app phải kèm token đọc release, thì electron-updater mới đọc được GitHub Releases.
- Luồng tự cập nhật đầu-cuối chỉ kiểm được khi có ít nhất hai bản release thật.
