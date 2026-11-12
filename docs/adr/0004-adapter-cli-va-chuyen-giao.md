# ADR-0004: Adapter CLI chạy headless JSON, chuyển giao ngữ cảnh giữa agent

- Trạng thái: Chấp nhận
- Ngày: 2026-11-12

## Bối cảnh

Bản dùng được đầu tiên cần chat với Claude Code và Codex trong cùng một app, đổi agent giữa chừng mà không mất mạch công việc. [PLAN.md](../PLAN.md) đặt ba tầng giao tiếp; tầng 2 (headless JSON) đã đủ ổn định với cả hai CLI.

## Quyết định

- **Hợp đồng adapter** ở `@nsa/adapter-sdk`: `detect()`, `capabilities()`, `run(options, onEvent)` trả về `{ cancel, finished }`. Luồng sự kiện chuẩn: `session`, `text`, `tool_call`, `tool_result`, `ask_permission`, `usage`, `error`, `done` (luôn cuối cùng).
- **Claude**: `claude -p --output-format stream-json --verbose --include-partial-messages --permission-mode <plan|acceptEdits> [--resume <id>]`.
- **Codex**: `codex exec [resume <id>] --json --skip-git-repo-check -c sandbox_mode="<read-only|workspace-write>" -`. Dùng `-c sandbox_mode` vì `exec resume` không nhận cờ `-s`.
- **Prompt luôn đi qua stdin**, không bao giờ nằm trong tham số dòng lệnh, để shim `.cmd` của npm trên Windows không diễn giải ký tự đặc biệt. Mã phiên được kiểm bằng regex (phải bắt đầu bằng chữ/số) trước khi đưa vào tham số.
- Chạy tiến trình bằng `cross-spawn`; huỷ bằng `taskkill /T` trên Windows để dừng cả cây tiến trình.
- **Quyền**: mỗi cuộc trò chuyện chọn "chỉ đọc" (mặc định) hoặc "được sửa file trong thư mục làm việc". Chế độ headless không hỏi quyền từng bước được, nên không có tuỳ chọn bỏ qua sandbox.
- **Chuyển giao**: `ChatService` lưu mã phiên theo từng agent. Khi gửi cho một agent, các lượt do agent khác làm mà agent này chưa thấy được tóm tắt (câu hỏi + câu trả lời, tối đa ~12k ký tự, ưu tiên lượt mới) và chèn trước yêu cầu mới. Agent đã có phiên thì vẫn resume phiên cũ, chỉ nhận phần còn thiếu.
- Cuộc trò chuyện lưu ở `%APPDATA%/NSA/conversations.json` (ghi file tạm rồi đổi tên).

## Hệ quả

- Thêm CLI mới chỉ cần một gói adapter mới và một dòng đăng ký trong `apps/desktop/src/main/index.ts`.
- Bộ phân tích được tách thành hàm thuần, test bằng đầu ra thật của CLI; CLI đổi định dạng thì cập nhật fixture và parser.
- Tóm tắt chuyển giao hiện là văn bản thô; giai đoạn 2 (NSA Mem) sẽ thay bằng ngữ cảnh chắt lọc.
