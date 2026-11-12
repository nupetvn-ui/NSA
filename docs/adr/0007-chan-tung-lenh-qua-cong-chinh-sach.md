# ADR-0007: Chặn từng lệnh bên trong một lượt qua cổng chính sách

- Trạng thái: Chấp nhận
- Ngày: 2026-11-12
- Bổ sung cho [ADR-0005](0005-o-cam-chinh-sach-nhat-ky-danh-tinh.md) (mục "Giới hạn hiện tại")

## Bối cảnh

ADR-0005 chỉ chặn được ở mức lượt chạy. Bên trong một lượt, CLI tự chạy lệnh theo chế độ quyền đã chọn. Bản Doanh nghiệp cần chặn được từng lệnh, nên ổ cắm `Policy` phải được hỏi trước mỗi lệnh.

## Quyết định

- `PolicyAction` có thêm loại **`agent.tool`**: agent, thư mục, quyền, cuộc trò chuyện, lượt, tên công cụ, tham số dạng văn bản.
- **Cổng chính sách** (`ToolGateServer`, `@nsa/adapter-sdk`):
  - máy chủ HTTP chỉ nghe `127.0.0.1`, cổng ngẫu nhiên, mở lúc app khởi động;
  - mỗi lần thử của một lượt được cấp một mã bí mật 24 byte, huỷ khi lượt kết thúc;
  - mã sai hoặc đã hết hạn thì luôn **chặn**.
- Adapter khai báo `toolGate: true` phải gắn móc của CLI khi `RunOptions.gate` có giá trị. Móc phải **lỗi là chặn**. Lý do: khi thử thật, cả Claude Code lẫn OpenCode đều cho lệnh chạy tiếp nếu móc tự lỗi (ví dụ thiếu file script).
- Lõi xử lý câu trả lời của `Policy`:
  - `allow`: cho lệnh chạy;
  - `deny`: CLI nhận lý do chặn, agent thấy lệnh bị từ chối;
  - `ask`: hiện hộp **Cho phép / Từ chối** giữa lượt (sự kiện `ask_permission` / `permission_result`). Quá 4 phút không trả lời, hoặc lượt bị dừng, thì coi là từ chối. 4 phút để kịp trước giới hạn 5 phút của `fetch` trong script móc.
- Mọi quyết định cho từng lệnh đều vào `AuditLog`: mục `policy` có thêm `tool: { name, input }`.
- Chính sách bản Cá nhân cho từng lệnh:
  - **chặn** lệnh phá huỷ hiển nhiên: `rm -rf /` hoặc `~`, `format c:`, `mkfs`, `dd of=/dev/…`, xoá đệ quy cả ổ đĩa, fork bomb;
  - **hỏi** với `git push`, `npm/pnpm/yarn publish`, `git reset --hard`, `git clean -f`, tải rồi chạy mã từ mạng;
  - còn lại cho phép.

## Theo từng CLI

| CLI         | Cơ chế                                                                                                                                                            | Kết quả                                                                                                                                                                                                              |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Claude Code | Móc `PreToolUse` (matcher `*`) qua `--settings <file tạm>`. Script móc chạy bằng runtime của NSA (`ELECTRON_RUN_AS_NODE=1`), trả `permissionDecision: deny`       | **Chạy thật**: test hợp đồng chặn được lệnh. Trong app, `git push` bị hỏi, bấm Từ chối thì agent nhận "người dùng không cho phép"                                                                                    |
| OpenCode    | Plugin `tool.execute.before` nạp qua `OPENCODE_CONFIG_CONTENT` (gộp với cấu hình sẵn có), ném lỗi để chặn                                                         | **Chạy thật**: lệnh `bash` bị chặn                                                                                                                                                                                   |
| Codex       | Có `hooks.PreToolUse` (bật mặc định), nhưng móc chỉ chạy khi người dùng đã **tin** móc đó (`/hooks` trong CLI) hoặc khi dùng cờ `--dangerously-bypass-hook-trust` | **Chưa chặn được**. Đã thử: móc truyền qua `-c hooks.PreToolUse=…` bị bỏ qua im lặng, lệnh vẫn chạy. NSA không dùng cờ "dangerously". `toolGate: false`, chỉ chặn ở mức lượt + sandbox `read-only`/`workspace-write` |
| Gemini CLI  | Có móc `BeforeTool` trong `settings.json` (trả `decision: deny`)                                                                                                  | **Chưa làm**: chưa xác minh được cách nạp settings cho riêng một lần chạy mà không sửa file của người dùng, và chưa chạy thật được (chưa đăng nhập)                                                                  |
| Antigravity | Tài liệu headless không mô tả móc; có trang "Lifecycle hooks" chưa xác minh                                                                                       | **Chưa làm**                                                                                                                                                                                                         |
| PTY         | Không có                                                                                                                                                          | Chỉ chặn ở mức lượt                                                                                                                                                                                                  |

Bộ định tuyến ưu tiên agent có `toolGate` khi tự chọn hoặc khi phải đổi agent.

## Hệ quả

- Bản Doanh nghiệp chỉ cần cắm `Policy` riêng: cùng một ổ cắm quyết định cả lượt chạy lẫn từng lệnh.
- Với Codex, Gemini, Antigravity và tầng PTY, bản Doanh nghiệp vẫn phải dựa vào sandbox của CLI hoặc hộp cát của NSA (giai đoạn 9). Nên cấm các agent này nếu chính sách đòi chặn từng lệnh.
- Hướng cho Codex: hướng dẫn người dùng tin móc của NSA một lần, hoặc đi qua `codex app-server` (có duyệt từng lệnh qua giao thức). Để sau.
- Script móc nằm trong thư mục tạm của tiến trình (`%TEMP%\nsa-gate-<pid>`). Mã bí mật truyền qua biến môi trường, không nằm trong tham số dòng lệnh.
