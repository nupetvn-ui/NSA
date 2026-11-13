# ADR-0008: NSA Mem — kho nhớ Markdown + git, chỉ mục FTS5, hộp duyệt, MCP tạm cho agent

- Trạng thái: Chấp nhận
- Ngày: 2026-11-13
- Bổ sung cho [ADR-0004](0004-adapter-cli-va-chuyen-giao.md) (ngữ cảnh chuyển giao) và [ADR-0005](0005-o-cam-chinh-sach-nhat-ky-danh-tinh.md) (ổ cắm)

## Bối cảnh

Giai đoạn 2 của [PLAN.md](../PLAN.md): cây nhánh, tìm kiếm, hộp duyệt, chắt lọc tự động, nhập lịch sử chat; mỗi mục nhớ có chủ sở hữu và phạm vi. Xong khi "Agent B nhớ điều đã dạy agent A". Nguyên tắc 5: bộ nhớ nằm ở NSA, không nằm trong agent.

## Quyết định

### Kho nhớ (bản gốc)

- Thư mục `%APPDATA%\NSA\memory` (thư mục dữ liệu người dùng, không nằm trong repo). Mỗi nhánh là một thư mục (tên không dấu, ví dụ `nguoi-dung`, `du-an/nsa`) có `_branch.md` (tiêu đề, tự duyệt hay không, ngưỡng tin cậy, ẩn hay không). Mỗi mục nhớ là `<mã>.md`.
- Phần đầu mỗi file: `id`, `title`, `kind` (`fact` / `preference` / `rule` = quy tắc hành vi), `subject` (khoá chủ đề), `confidence`, `sensitive`, `source` (nguồn gốc: người dùng dạy / agent đề xuất / chắt lọc / nhập lịch sử, kèm agent và mã cuộc trò chuyện), `owner`, `scope`, `team`, `tags`, `created`, `updated`. Mỗi dòng là `khoá: <JSON>` — vẫn là YAML hợp lệ, không cần thư viện YAML.
- Nhánh mặc định: Về người dùng, Dự án, Kiến thức chung (tự duyệt), Quy tắc cho agent (luôn chờ người duyệt).
- **Lịch sử git cục bộ** bằng `isomorphic-git` (thuần JavaScript: máy người dùng không cần cài git, đóng gói không có nhị phân gốc; được gộp vào bundle main). Mỗi thay đổi một commit, thông điệp có dòng `NSA-Op` / `NSA-Entry` / `NSA-Path`.
- **Hoàn tác** một thay đổi = đưa các file của commit đó về như trước commit, ghi thành commit mới (hoàn tác được tiếp). Chỉ hoàn tác được thay đổi **mới nhất** của một file; thay đổi cũ hơn thì phải hoàn tác thay đổi mới hơn trước (tránh ghi đè âm thầm).

### Ổ cắm thứ tư: chủ sở hữu + phạm vi

- `MemoryAccess` trong `packages/core/src/memory.ts`: `ownershipFor(actor, branch)`, `canRead`, `canWrite`. Phạm vi `personal` / `team`.
- Bản Cá nhân cắm `personalMemoryAccess`: một người một máy — mục mới thuộc người dùng hiện tại, phạm vi cá nhân; không có mục nhóm. Bản Doanh nghiệp (giai đoạn 9) cắm bộ có nhóm, phân quyền theo nhánh, mã hoá — không sửa lõi.

### Chính sách và nhật ký

- `PolicyAction` thêm `memory.write` (tạo / sửa / xoá / hoàn tác; mục hay nhánh; người dùng hay bộ tự duyệt) và `memory.propose` (agent hoặc bộ chắt lọc đưa đề xuất vào hộp duyệt). Chính sách bản Cá nhân cho phép cả hai — việc giữ lại chờ duyệt là của hộp duyệt.
- Chính sách chặn thì không file nào bị ghi; tự duyệt bị chặn thì đề xuất nằm lại hộp duyệt kèm lý do.
- `AuditEntry` thêm loại `memory`: thao tác, ai làm (người dùng / tự động / agent), mục, đề xuất, quyết định.

### Tìm kiếm

- **SQLite FTS5 qua `node:sqlite`** có sẵn trong Node 24 / Electron 45 — **không có module native nào phải đóng gói**. Đã kiểm trong bản đóng gói (`NSA.exe`), không chỉ trong dev (bài học node-pty ở ADR-0006).
- Tách từ `unicode61 remove_diacritics 2`: gõ không dấu vẫn tìm ra ("di ung tom" → "dị ứng tôm"). Câu hỏi tự nhiên được tách thành các từ nối bằng OR (bỏ từ quá phổ biến), xếp theo bm25.
- Chỉ mục nằm ở `memory\.nsa\index.sqlite` (git bỏ qua). Mất file, hoặc số mục khác số file Markdown → tự dựng lại khi mở; màn hình Cài đặt có nút **Dựng lại**.
- **Tìm theo vector: chưa có.** Chỉ có interface `VectorIndex` (bộ cắm mặc định `noVectorIndex`). Hướng dự kiến: `sqlite-vec` (nạp extension qua `node:sqlite`) + model embedding chạy cục bộ. Chưa làm vì cả hai đều là nhị phân gốc / model vài chục MB, cần thử riêng trong bản đóng gói và chọn model đủ tốt cho tiếng Việt. Hiện kho cỡ cá nhân nhỏ (≤ 60 mục thì chèn cả kho), nên FTS5 đủ dùng.

### Hộp duyệt và tự duyệt

Mọi đề xuất (agent qua `mem_propose`, chắt lọc, nhập lịch sử) vào `memory\.nsa\inbox.json`. Quy tắc (hàm thuần `judgeProposal`):

- **Tự nhận** khi: nhánh bật tự duyệt, độ tin cậy ≥ ngưỡng của nhánh, không phải quy tắc hành vi, không nhạy cảm, không mâu thuẫn.
- **Chờ người duyệt** khi: quy tắc hành vi; nhạy cảm (đánh dấu, hoặc phát hiện mật khẩu, khoá API, số thẻ / tài khoản, CCCD, số điện thoại); độ tin cậy thấp; nhánh luôn duyệt; sửa mục đã có; **mâu thuẫn**.
- **Mâu thuẫn** (không dùng model): cùng `subject` mà nội dung khác, hoặc giống ≥ 50% từ (Jaccard trên từ đã bỏ dấu) mà không y hệt. Cố ý dè dặt: nghi thì giữ lại cho người xem.
- **Trùng y hệt** → tự từ chối.
- Người dùng: Nhận / Sửa rồi nhận / Từ chối; đề xuất có đúng một mục mâu thuẫn thì có thêm **Nhận, thay mục cũ** (mục cũ khôi phục được qua Lịch sử). Nhận xong, đề xuất khác trùng y hệt tự bỏ.

### Tự chắt lọc

- Ngưỡng (cấu hình trong màn hình Bộ nhớ, lưu ở `%APPDATA%\NSA\memory-settings.json`): sau mỗi N lượt (mặc định 8), cuộc trò chuyện im N phút = kết thúc (mặc định 15), người dùng sửa lỗi agent ("sai rồi", "không phải"…), người dùng dặn nhớ ("hãy nhớ", "từ nay"…). Nút "Ghi nhớ cuộc trò chuyện" chắt lọc ngay.
- Chắt lọc = `ChatService.runTask`: giao một agent (mặc định Tự chọn) qua adapter sẵn có, **luôn chỉ đọc**, trong thư mục trống `memory-work`; vẫn hỏi `Policy` (`agent.run`) và ghi `AuditLog`; agent hỏng thì thử agent kế tiếp. Prompt gồm nhánh, bộ nhớ hiện có (để không đề xuất lại) và đoạn chat (tối đa ~24k ký tự, ưu tiên phần cuối). Agent trả JSON; đề xuất vào hộp duyệt. Đã chắt lọc tới lượt nào thì lưu ở `memory\.nsa\distill-progress.json`.

### Nhập lịch sử chat

Chỉ chạy khi người dùng bấm, sau khi xem trước danh sách phiên (vài câu đầu mỗi phiên). Định dạng **đã xác minh trên máy thật** (2026-11-12):

| Nguồn                   | Nơi lưu / định dạng                                                                                                                    | Trạng thái                                     |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| NSA                     | `conversations.json` của app                                                                                                           | Đọc được                                       |
| Claude Code 2.1         | `~/.claude/projects/<thư mục>/<phiên>.jsonl`, dòng `type: user/assistant`; bỏ khối do CLI chèn (`<system-reminder>`…), agent con, tool | Đọc được                                       |
| Codex 0.167             | `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`, dòng `session_meta` + `response_item` / `message`; bỏ `developer`, `AGENTS.md`         | Đọc được                                       |
| OpenCode 1.19           | SQLite `~/.local/share/opencode/opencode.db`, bảng `session` / `message` / `part` (cột `data` JSON), mở chỉ đọc                        | Đọc được                                       |
| OpenCode bản cũ         | file JSON trong `storage/`                                                                                                             | **Chưa hỗ trợ**                                |
| Gemini CLI, Antigravity | —                                                                                                                                      | **Chưa làm** (máy chưa có dữ liệu để xác minh) |

### Cho agent dùng

- **Ngữ cảnh tự chèn**: `ChatService` có phần mở rộng `ChatExtension` (`contextFor` / `mcpFor` / `turnStarted` / `turnFinished`). Đầu mỗi lượt, NSA chèn khối `[Bộ nhớ NSA]` trước yêu cầu (trước cả ngữ cảnh chuyển giao): mọi quy tắc hành vi, các mục khớp câu hỏi (FTS5), và — khi kho ≤ 60 mục — các mục mới nhất cho tới giới hạn ký tự (mặc định 4000). Mục nhạy cảm không bao giờ tự chèn. Lượt ghi lại mục đã dùng (`Turn.memory`), giao diện hiện "dùng N mục nhớ".
- Agent có MCP luôn được báo có tool `mem_*`, kể cả khi kho trống. Lý do: khi chạy thật với kho trống, Claude Code định ghi vào bộ nhớ riêng của nó; OpenCode ở chế độ `plan` ngại gọi `mem_propose` vì tưởng là thao tác ghi — lời nhắc nay nói rõ tool không sửa file.
- **Ba thao tác** `mem_search` / `mem_read` / `mem_propose` là lớp dịch vụ thuần trong `packages/memory` (`MemoryService.tools()`). `mem_propose` chỉ đưa vào hộp duyệt, không ghi thẳng.
- **Nối tạm qua MCP** (`McpHttpServer`, `packages/memory/src/mcp-server.ts`): server streamable HTTP tối giản (chỉ JSON, không SSE) trên `127.0.0.1`, cổng ngẫu nhiên. Mỗi lần chạy một lượt được cấp mã bí mật 24 byte gắn với agent + cuộc trò chuyện, hết hạn khi lượt xong. Tên server `nsa_mem`; tên tool dùng gạch dưới (Claude không nhận dấu chấm trong tên tool).
- `RunOptions.mcpServers` (hợp đồng `attachMcp` của PLAN.md, theo từng lượt). Mã bí mật **chỉ qua biến môi trường** `NSA_MCP_NSA_MEM_TOKEN`:

| CLI                      | Cách gắn                                                                                                | Chạy thật?                                                                  |
| ------------------------ | ------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| Claude Code              | `--mcp-config <file tạm>` (header `Bearer ${NSA_MCP_NSA_MEM_TOKEN}`) + `--allowedTools mcp__nsa_mem__…` | Có. Chế độ `plan` chỉ cho gọi tool có `readOnlyHint` — ba tool đều khai báo |
| Codex                    | `-c mcp_servers.nsa_mem.url=…` + `bearer_token_env_var`                                                 | Có                                                                          |
| OpenCode                 | khối `mcp` (`type: remote`, header `{env:…}`) gộp vào `OPENCODE_CONFIG_CONTENT`                         | Có                                                                          |
| Gemini, Antigravity, PTY | chưa gắn                                                                                                | Chỉ nhận ngữ cảnh tự chèn                                                   |

`mem_propose` khai báo `readOnlyHint` vì nó không sửa gì trên máy hay trong thư mục làm việc — chỉ thêm một đề xuất vào hộp duyệt mà người dùng quyết.

**Giai đoạn 3 sẽ chuyển ba tool này vào MCP gateway chung** (cùng ổ cắm chính sách cho tool của plugin); `McpHttpServer` khi đó bỏ đi, `MemoryService.tools()` giữ nguyên.

## Kết quả chạy thật (2026-11-12/13)

- Dev và **bản đóng gói** (`NSA.exe`, thư mục dữ liệu riêng qua `NSA_USER_DATA`): dặn Claude Code "hãy nhớ: mèo tên Mít Tố Nữ" → bộ chắt lọc tự nhận → cuộc trò chuyện mới với Codex trả lời đúng. Bản đóng gói: dặn OpenCode "dị ứng tôm" → cuộc trò chuyện mới với Claude cảnh báo đúng.
- Claude Code tự gọi `mem_propose` qua MCP trong app; đề xuất mâu thuẫn ("mèo tên Bơ") nằm lại hộp duyệt, mục cũ không đổi.
- Hoàn tác qua giao diện: file về giống từng byte bản trước khi sửa.
- Xoá `index.sqlite` rồi mở lại (dev và bản đóng gói): dựng lại từ Markdown, tìm không dấu vẫn ra.

## Hệ quả

- Bản Doanh nghiệp cắm `MemoryAccess`, `Policy`, `AuditLog`, `VectorIndex` riêng; mã hoá trên đĩa sẽ cần một lớp lưu trữ thay cho file Markdown thô (để giai đoạn 9).
- Phát hiện mâu thuẫn bằng từ khoá có thể giữ lại cả điều không thật sự mâu thuẫn (ví dụ hai sở thích về đồ uống) — chấp nhận, vì sai về phía người duyệt.
- Phiên rất dài chỉ được chắt lọc ~24k ký tự cuối.
- Nhánh ẩn của plugin (Zalo, Telegram…) có sẵn trường `hidden` nhưng chưa có plugin nào dùng (giai đoạn 4).
