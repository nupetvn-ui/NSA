# ADR-0006: Điều phối nhiều agent — năng lực, định tuyến, ba tầng tự lùi, phát hiện thay đổi

- Trạng thái: Chấp nhận
- Ngày: 2026-11-12
- Bổ sung cho [ADR-0004](0004-adapter-cli-va-chuyen-giao.md)

## Bối cảnh

Giai đoạn 1 của [PLAN.md](../PLAN.md) cần đủ năm adapter (claude, codex, opencode, gemini, pty), bộ định tuyến theo năng lực, nguyên tắc 3 (ba tầng giao tiếp, tự lùi tầng) và nguyên tắc 6 (tự phát hiện CLI thay đổi, test hợp đồng hằng đêm).

## Quyết định

### Adapter

| Adapter     | Tầng chính                                                                                                           | Chạy thật?                                                                                                      |
| ----------- | -------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| Claude Code | `claude -p --output-format stream-json …`                                                                            | Có (2.1.322): gửi, resume, huỷ, sửa file, chặn lệnh                                                             |
| Codex       | `codex exec --json …`                                                                                                | Có (0.167.2): gửi, resume, huỷ, sửa file                                                                        |
| OpenCode    | `opencode run --format json --agent plan\|build [-s <phiên>]`                                                        | Có (1.19.5, model miễn phí `opencode/big-pickle`): gửi, resume, huỷ, sửa file, chặn lệnh                        |
| Gemini CLI  | `gemini -p "" --output-format stream-json --skip-trust --approval-mode plan\|auto_edit`                              | **Chưa**: máy chưa đăng nhập Gemini. Chỉ ghi được lỗi xác thực thật (mã thoát 41). Định dạng JSON theo tài liệu |
| Antigravity | `agy --print --input-format stream-json --output-format stream-json --mode plan\|accept-edits [--conversation <id>]` | **Chưa**: máy chưa cài CLI `agy`. Viết theo tài liệu chính thức                                                 |
| PTY         | chạy chế độ in của CLI bất kỳ (prompt qua stdin) hoặc mở terminal giả (ConPTY, `@lydell/node-pty`) và gõ prompt      | Có: văn bản thô với Claude; terminal giả với REPL Node, cả trong bản đóng gói                                   |

- Mọi adapter giữ quy tắc của ADR-0004: **prompt chỉ đi qua stdin** (Antigravity: bọc trong một dòng JSON trên stdin), mã phiên được kiểm bằng regex trước khi đưa vào tham số.
- Trình chạy CLI đặt `PWD` = thư mục làm việc. Lý do: khi chạy thật, OpenCode lấy thư mục từ biến `PWD` thừa hưởng và đã ghi file vào thư mục của NSA.
- OpenCode: agent có sẵn `plan` chỉ đọc (đã thử: từ chối sửa file), `build` được sửa.
- CLI chưa có adapter riêng: người dùng khai báo trong `%APPDATA%\NSA\custom-clis.json` (`id`, `displayName`, `command`, `args`, `input: stdin|type`, `doneWhen`), NSA chạy qua adapter PTY.

### Antigravity

Đã xác minh từ tài liệu chính thức (antigravity.google/docs/cli/headless và /reference):

- Antigravity **có CLI riêng (`agy`) với chế độ headless** (`-p/--print`, `--output-format text|json|stream-json`, `--input-format stream-json`). Mã phiên là `conversation_id`, tiếp tục bằng `--conversation <id>`.
- Chế độ headless dùng thông tin đăng nhập đã lưu, nên phải chạy `agy` tương tác một lần để đăng nhập. Hành động cần duyệt mà không có `--dangerously-skip-permissions` thì bị từ chối mềm (vẫn thoát 0). NSA không dùng cờ đó.
- Trang Gemini CLI ghi rằng Gemini CLI đã được Antigravity CLI thay thế (18/06/2026). NSA vẫn giữ adapter Gemini cho người còn dùng bản cũ.
- Máy phát triển có **Antigravity IDE** (`%LOCALAPPDATA%\Programs\antigravity`), không có `agy`. File `~/.gemini/antigravity/bin/agentapi.bat` chỉ gọi `language_server.exe agentapi`, một giao diện nội bộ của IDE không có tài liệu, nên NSA **không** dùng.
- Kết luận: đi qua adapter `agy`; nếu `agy` đổi định dạng thì lùi xuống tầng PTY (`agy --print`, văn bản thô).

### Bảng năng lực và định tuyến

- `capabilities()` gồm `streaming`, `resume`, `tools`, `editFiles`, `images`, `mcp`, `subagents`, `toolGate` (chặn được từng lệnh) và `tier` (`protocol`/`headless`/`pty`).
- `planRoute` (lõi) xếp agent:
  - loại agent chưa cài, thiếu năng lực cần thiết (quyền sửa file cần `tools` + `editFiles`) hoặc đã hỏng trong lượt;
  - ưu tiên agent người dùng chọn, rồi agent đã sẵn sàng, rồi agent chặn được từng lệnh, rồi theo thứ tự đăng ký.
- Giao diện có lựa chọn **Tự chọn** (`agentId: "auto"`).

### Ba tầng tự lùi và đổi agent

- Sự kiện `error` có `code`: `not_installed`, `auth`, `protocol`, `cli`. CLI kết thúc mà không in dòng JSON nào thì trình chạy phát `protocol` (dấu hiệu CLI đổi cờ hoặc định dạng).
- Một lượt có thể qua nhiều lần thử. Lỗi được giữ lại cho tới khi lõi quyết định:
  1. `protocol` và adapter có `fallback` thì lùi xuống tầng PTY của cùng CLI. Tầng PTY không resume được nên nhận toàn bộ ngữ cảnh.
  2. Còn lỗi (chưa cài, chưa đăng nhập, CLI lỗi) thì đổi sang agent tiếp theo của `planRoute`, với điều kiện người dùng không tắt `autoSwitch`.
  3. Agent đã trả lời được một phần thì không thử lại, để tránh làm lại việc. Tối đa 4 lần thử mỗi lượt.
- **Mỗi lần đổi agent đều hỏi lại `Policy`** (`agent.run`). Chính sách không cho thì dừng và báo.
- Người dùng thấy thông báo (`notice`) ngay trong lượt. `AuditLog` ghi mục `fallback` (`kind: tier|agent`, từ đâu, sang đâu, lý do).
- Giả lập để thử: `NSA_SIMULATE_BROKEN=claude` (tầng chính lỗi giao thức) hoặc `claude:missing` (như chưa cài).

### Tự phát hiện thay đổi

- Mỗi lần khởi động, `detectCliChanges` lấy `--version` + `--help` của từng CLI (Codex: `exec --help`, OpenCode: `run --help`), so với `%APPDATA%\NSA\cli-fingerprints.json`. Khác thì hiện banner kèm các dòng `--help` mới hoặc bị bỏ, và ghi `cli_change` vào nhật ký.
- Bộ test hợp đồng `runContract` (trong `@nsa/adapter-sdk`) có 5 bước: gửi, prompt qua stdin, resume, huỷ, cổng chặn lệnh.
  - Chế độ `fake`: CLI giả phát lại đầu ra thật, chạy trong mọi lần `pnpm test`.
  - Chế độ `live`: gọi CLI thật, chạy bằng `pnpm test:live` với `NSA_LIVE_CONTRACT=1`.
  - Bước cần đăng nhập mà máy không có thì ghi **bỏ qua** kèm lý do.
- `.github/workflows/contract-nightly.yml` chạy mỗi đêm với bản CLI mới nhất từ npm và in bảng tóm tắt. OpenCode chạy thật được trên CI nhờ model miễn phí; Claude, Codex, Gemini chỉ chạy khi repo có secret khoá API.

## Hệ quả

- Thêm CLI mới: một gói adapter, một dòng trong `apps/desktop/src/main/agents.ts`, một bản ghi đầu ra thật cho test hợp đồng.
- Tầng PTY cần module native `@lydell/node-pty`. Gói nhị phân Windows phải khai báo trực tiếp trong `apps/desktop` thì electron-builder mới đóng gói (đã thử bản đóng gói).
- Phần "giao một agent khác đọc changelog để đề xuất bản vá adapter" của nguyên tắc 6 chưa làm.
