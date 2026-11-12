# ADR-0005: Ổ cắm chính sách, nhật ký, danh tính trong lõi

- Trạng thái: Chấp nhận
- Ngày: 2026-11-12

## Bối cảnh

[PLAN.md](../PLAN.md) (mục "Hai bản đóng gói") chốt một lõi chung cho bản Cá nhân và bản Doanh nghiệp. Lõi phải có sẵn ổ cắm từ giai đoạn 1, nếu không thì về sau phải sửa mọi adapter và plugin đã viết.

## Quyết định

- Lõi (`packages/core/src/sockets.ts`) chỉ định nghĩa ba interface, không chứa nghiệp vụ doanh nghiệp:
  - **`IdentityProvider`** → `Identity { id, displayName, roles, edition }`. Chưa có license (giai đoạn 8).
  - **`Policy.check({ actor, action, confirmed })`** → `allow` / `ask` (kèm lý do) / `deny` (kèm lý do). Hiện có một loại hành động là `agent.run`; plugin sẽ thêm loại của mình ở giai đoạn 3.
  - **`AuditLog.record(entry)`**: các mục `request`, `policy`, `agent_event` (mọi sự kiện chuẩn trừ từng mẩu văn bản) và `reply` (văn bản trả lời gộp lại khi xong lượt). Mỗi mục kèm thời điểm và người ra lệnh.
- `ChatService` bắt buộc nhận `identity`. Mọi lượt đều hỏi chính sách **trước khi** gọi `adapter.run`. Kết quả `deny` thì không tạo lượt, không chạy lệnh nào. Chính sách ném lỗi cũng được coi là `deny`. Kết quả `ask` thì trả về `needs_confirmation`; giao diện hỏi người dùng rồi gửi lại với `confirmed: true`.
- Bộ cắm bản Cá nhân:
  - Danh tính: tài khoản hệ điều hành (`local:<username>`, vai trò `owner`).
  - Chính sách (`personalPolicy`): chỉ đọc thì cho phép. Cho sửa file thì hỏi một lần mỗi cuộc trò chuyện (ghi lại bằng `editConfirmed`). Sửa ngay ở gốc ổ đĩa hoặc thư mục người dùng thì cảnh báo mạnh hơn.
  - Nhật ký: JSON Lines cục bộ, mỗi tháng một file trong `%APPDATA%\NSA\audit\`. Xoá file là xoá lịch sử.
- Ổ cắm thứ tư (lưu trữ bộ nhớ có chủ sở hữu + phạm vi) để giai đoạn 2.

## Giới hạn hiện tại

- Chính sách chặn ở mức **lượt chạy agent**. Bên trong một lượt, Claude Code / Codex tự chạy công cụ theo chế độ quyền đã chọn (plan/acceptEdits, sandbox read-only/workspace-write). NSA ghi lại các lần gọi công cụ vào nhật ký, nhưng chưa chặn được từng lệnh một.
- Muốn chặn từng lệnh: với Claude có thể dùng `--permission-prompt-tool` qua cổng MCP của NSA (giai đoạn 3). Codex chưa có cơ chế tương đương ở chế độ headless.

## Hệ quả

- Bản Doanh nghiệp (giai đoạn 9) cắm chính sách do quản trị đặt, nhật ký kiểm toán không sửa được và danh tính SSO, mà không phải sửa lõi hay adapter.
- Test `chat.test.ts` chứng minh: chính sách trả `deny` thì `adapter.run` không bao giờ được gọi, kể cả khi đã `confirmed`, và kể cả lượt sau trong một cuộc trò chuyện đã có.
