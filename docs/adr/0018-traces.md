# ADR-0018: Traces — xem lại từng lượt chạy từ nhật ký, chỉ mục SQLite dựng lại được

- Trạng thái: Chấp nhận
- Ngày: 2026-11-14

## Bối cảnh

Giai đoạn 6b cần một màn hình xem lại từng lượt chạy (ai ra lệnh, agent nào, tool nào, chính sách quyết gì, lùi tầng, token, chi phí, lỗi). PLAN yêu cầu **không dựng nguồn ghi mới**: dữ liệu lấy từ nhật ký (`AuditLog`, ADR-0005) và sổ chi phí. Nhật ký là JSON Lines mỗi tháng một file, có thể lớn; đọc cả file mỗi lần mở màn hình sẽ làm treo giao diện (hướng G6: dần chuyển lưu trữ sang SQLite).

## Quyết định

**1. Nối các dòng của một lượt bằng `turnId` — bổ sung ở chỗ ghi, đọc được file cũ.** Trước đây `request` và `policy` của một lượt chat được ghi _trước khi_ lượt có mã (mã lượt và mã cuộc trò chuyện mới sinh trong `#start`), và việc nền (`runTask`) không có mã nào. `ChatService.send` giờ cấp sẵn `conversationId` + `turnId` trước khi ghi `request`; `runTask` cấp một `turnId` cho mỗi lần thử agent. Không thêm kiểu dòng mới, chỉ điền trường `turnId` / `conversationId` đã có trong `AuditEntry`. File nhật ký cũ (thiếu mã) vẫn đọc được: dòng không có `turnId` và không thuộc loại tự đứng được thì bị bỏ qua (có test).

**2. Lượt chạy = các dòng cùng `turnId`; sự kiện tự đứng cho phần còn lại.**

- `turn` (có cuộc trò chuyện) và `task` (việc nền, không có cuộc trò chuyện): gom theo `turnId`.
- `plugin`: mỗi dòng `plugin` loại `job | action | model | crash | denied` và mỗi `mcp_tool` của plugin không thuộc lượt nào (việc nền / hẹn giờ của plugin, sau này cả giai đoạn 6) là một lượt riêng. Vòng đời cài / bật / gỡ không phải "lượt chạy" nên bị bỏ.
- `system`: vượt hạn mức (`budget`), đổi model dự phòng ngoài lượt.
- Giai đoạn 6 (hẹn giờ) chỉ cần ghi `plugin`/`job` như đang ghi là tự hiện ở đây — không cần đụng Traces.

**3. Chi phí lấy từ nhật ký, không từ sổ chi phí.** Sổ chi phí của `providers` chỉ giữ **số đếm gộp theo tháng và model** (không theo lượt) nên không thể gán cho từng lượt. Token và chi phí của một lượt cộng từ các sự kiện `usage` trong nhật ký (`costUsd` có khi CLI / adapter `api` báo giá; không có thì "—", không đoán). Sổ chi phí chỉ dùng để hiện tổng tháng ở đầu màn hình.

**4. Chỉ mục SQLite, dựng lại được (gói `@nsa/traces`).** `node:sqlite` có sẵn (như NSA Mem, ADR-0008), file `userData/traces/index.sqlite`. Chỉ là bản sao: xoá, hỏng hoặc khác phiên bản thì bỏ và dựng lại từ file nhật ký gốc (có test). Đọc tăng dần theo vị trí byte từng file; dòng ghi dở để lần sau; đọc theo khối 1 MB, ghi theo lô và **nhường luồng giữa các lô** (`setImmediate`) để giao diện không treo (có test: 3.000 lượt, vòng lặp sự kiện vẫn chạy giữa chừng). Nhật ký bị xoá / thu nhỏ (người dùng xoá lịch sử) thì chỉ mục tự dựng lại. Chạy nền lúc khởi động; mỗi lần giao diện hỏi chỉ chờ tối đa 0,7 giây phần nhật ký mới rồi trả kết quả hiện có. Tìm theo chữ dùng cột văn bản đã gập dấu + `instr` (khớp "khach" với "khách", khớp cả giữa từ); chưa dùng FTS5 vì nhật ký bản Cá nhân vài chục nghìn lượt là đủ nhanh — đổi sang FTS5 khi cần mà không đổi giao diện.

**5. Bí mật không vào Traces.** Nhật ký đã được che key trước khi ghi (`providers.audit`, test quét ở `keyscan.test.ts`); Traces che thêm hai lần bằng đúng bộ che đó (`hub.redact`): khi đưa vào chỉ mục và khi đọc ra (key thêm sau khi ghi vẫn bị che). Test: key giả không có trong kết quả trả về, trong tìm kiếm, và trong chính file SQLite. Nội dung mỗi bước cắt ở 8.000 ký tự (đánh dấu "đã cắt").

**6. Giao diện** là màn hình riêng (`TracesView`): danh sách + chi tiết từng bước, lọc theo ngày / agent / plugin / trạng thái / loại, tìm chữ, mở rộng nội dung dài, tự làm mới khi có lượt đang chạy. Kênh IPC `traces:*` nằm ở `packages/core/src/traces.ts` (kiểu + hợp đồng), cắm vào `registerIpc` qua một tham số riêng để các màn hình thêm sau không phải sửa danh sách kênh chung.

**7. Ranh giới gói (ADR-0015).** `@nsa/traces` chỉ import `@nsa/core` (kiểu). `core` chỉ giữ kiểu Traces và hợp đồng IPC; việc đọc file + SQLite nằm ngoài lõi, lắp ghép ở `apps/desktop`.

## Hệ quả

- Lượt chat mới có đủ mọi dòng cùng `turnId`; nhật ký cũ chỉ cho Traces thấy phần sau `request`/`policy` (lượt cũ thiếu hai dòng đầu nên có thể không có tiêu đề).
- Chi phí từng lượt chỉ có khi nguồn báo giá; lượt qua CLI gói thuê bao hiện "—".
- `request` của việc nền ghi `[mục đích]` chứ không phải nội dung lệnh (như cũ) — Traces hiện đúng như vậy.
- Giai đoạn 6b phần 2 (đội agent) gắn mã việc vào dòng nhật ký (`teamTaskId`) để nhảy từ bảng việc sang Traces; Traces đã có sẵn bộ lọc theo mã này.
- Chưa có: xuất Traces cho nhật ký kiểm toán bản Doanh nghiệp (giai đoạn 9), xoá chọn lọc, giữ chỉ mục theo thời hạn.
