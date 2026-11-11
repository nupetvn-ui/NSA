# NSA — Kế hoạch tổng thể

## Bối cảnh

NSA là app desktop điều phối nhiều agent lập trình chạy qua CLI (Claude Code, Codex, OpenCode, Gemini CLI/Antigravity…), kèm một App Store gồm các công cụ cài thêm (Zalo, Telegram, Discord, Knowledge Base, Hẹn giờ, tự động hoá trình duyệt, Content Factory…) và một bộ nhớ riêng tự học, tự duyệt, được dạy bằng ảnh, video, văn bản và lịch sử chat.

Bài học từ AGS: khi nhà cung cấp tự thêm tính năng (ví dụ Claude Mod), mọi tiện ích giao diện trong phạm vi một agent sẽ bị thay thế. Thứ còn giá trị lâu dài là **điều phối nhiều agent, bộ nhớ thuộc về người dùng, và các công cụ nối ra thế giới bên ngoài**. NSA chỉ đầu tư vào ba thứ đó.

Quyết định đã chốt: app desktop, TypeScript/Node.js, làm sản phẩm thương mại ngay từ đầu. Repo `nupetvn-ui/NSA` hiện trống, đã clone về `D:\NSA`.

## Nguyên tắc để NSA không gãy khi nhà cung cấp update

1. **NSA không sở hữu model, chỉ gọi CLI của người dùng.** Người dùng tự đăng nhập gói của họ; NSA không bán lại quyền truy cập, nên không phụ thuộc chính sách API của ai.
2. **Mỗi CLI là một adapter rời, cập nhật độc lập với app.** Adapter là gói riêng có phiên bản, tải về như plugin; CLI đổi cú pháp thì phát hành adapter mới trong ngày, không cần ra bản app mới.
3. **Ba tầng giao tiếp, tự lùi tầng khi hỏng:** giao thức chuẩn (ACP, SDK chính thức) → chế độ headless có JSON (`claude -p --output-format stream-json`, `codex exec --json`, `opencode run`/`serve`, `gemini -p`) → giả lập terminal (PTY) đọc màn hình. Tầng cuối luôn chạy được với bất kỳ CLI nào.
4. **Công cụ viết một lần theo chuẩn MCP.** Mọi app trong App Store lộ tool qua một cổng MCP của NSA; CLI nào hỗ trợ MCP đều dùng được ngay, kể cả CLI ra đời sau này.
5. **Bộ nhớ nằm ở NSA, không nằm trong agent.** Lưu dạng file Markdown + SQLite trên máy người dùng, agent nào cũng đọc/ghi qua cùng một tool. Đổi model không mất gì.
6. **Tự phát hiện thay đổi.** Mỗi lần khởi động và mỗi đêm: đọc phiên bản + `--help` của từng CLI, so với lần trước, chạy bộ test hợp đồng (gửi prompt, gọi tool, tiếp tục phiên, huỷ). Hỏng thì tự lùi tầng, báo người dùng, và giao một agent khác đọc changelog để đề xuất bản vá adapter (người duyệt trước khi áp dụng).
7. **Tính năng mới của nhà cung cấp thành điểm cộng.** Mỗi adapter khai báo bảng năng lực (ảnh, subagent, mod, MCP, resume…); bộ định tuyến chọn agent theo năng lực nên CLI càng mạnh, NSA càng mạnh.
8. **Không làm lại thứ nhà cung cấp sẽ tự làm.** Không xây tiện ích giao diện cho riêng một agent.

## Kiến trúc

```
Electron (giao diện React)
   │ IPC
Lõi NSA (Node, tiến trình nền)
   ├─ Orchestrator: phiên, hàng đợi việc, định tuyến, chuyển giao giữa agent
   ├─ Adapter host ── claude / codex / opencode / gemini / pty-chung
   ├─ MCP Gateway ── gom tool của mọi plugin thành 1 server MCP
   ├─ NSA Mem ── cây nhánh, hộp duyệt, chắt lọc, tìm kiếm
   ├─ Plugin host ── cài, cấp quyền, chạy cô lập, cập nhật
   └─ Scheduler + Event bus
```

Cấu trúc repo (pnpm workspace):

```
apps/desktop          Electron + React
packages/core         orchestrator, event bus, scheduler
packages/adapter-sdk  hợp đồng adapter + bộ test hợp đồng
packages/adapters/*   claude, codex, opencode, gemini, pty
packages/mcp-gateway
packages/memory       NSA Mem
packages/plugin-sdk   manifest, quyền, API giao diện
plugins/*             zalo, telegram, discord, knowledge-base, scheduler, browser, content-factory
docs/                 PLAN.md, ADR, đặc tả
```

### Hợp đồng adapter
`detect()` (đã cài chưa, phiên bản), `capabilities()`, `start/send/resume/cancel`, luồng sự kiện chuẩn hoá (`text`, `tool_call`, `tool_result`, `ask_permission`, `usage`, `done`, `error`), `attachMcp(url)`. Antigravity: cần xác minh nó có chế độ CLI/headless ổn định không; nếu chưa có thì đi qua Gemini CLI hoặc tầng PTY.

### NSA Mem
- **Cấu trúc:** cây nhánh như AGSMem. Mỗi plugin có nhánh ẩn riêng (ví dụ `Zalo → quy tắc chung / theo nhóm/<mã> / theo nick/<mã>`). Mỗi mục nhớ là một file Markdown có nguồn gốc, độ tin cậy, ngày.
- **Lưu trữ:** file Markdown là bản gốc (có lịch sử git cục bộ để hoàn tác), SQLite FTS5 + vector để tìm kiếm.
- **Nạp:** văn bản, tài liệu, ảnh (model nhìn ảnh mô tả), video (ffmpeg tách khung hình + phụ đề từ nhận dạng giọng nói), lịch sử chat (nhập từ phiên của các CLI và từ kênh chat).
- **Tự học:** khi đạt ngưỡng (số tin, mốc thời gian, kết thúc phiên, người dùng sửa lỗi agent) → agent chắt lọc thành đề xuất ghi nhớ → vào **hộp duyệt**.
- **Tự duyệt:** quy tắc theo nhánh — tự nhận khi độ tin cậy cao và không mâu thuẫn; mâu thuẫn, nhạy cảm hoặc là quy tắc hành vi thì chờ người duyệt. Mọi thay đổi hoàn tác được.
- **Dùng:** tool MCP `mem.search / mem.read / mem.propose`, cộng phần ngữ cảnh tự chèn đầu mỗi phiên.

### App Store
- Mỗi app là một plugin có `nsa-plugin.json`: tên, biểu tượng, phiên bản, quyền xin cấp, tool MCP, màn hình giao diện, việc chạy nền, nhánh nhớ.
- Chạy trong tiến trình riêng, chỉ được dùng quyền đã cấp. Thao tác nhạy cảm (đổi trưởng nhóm, xoá, gửi hàng loạt) luôn cần người xác nhận.
- Kho plugin trực tuyến: gói có chữ ký, kiểm phiên bản tương thích, cập nhật tự động, nút "Quản lý" để bật/tắt/gỡ.
- Plugin SDK công khai để bên thứ ba viết app.

## Lộ trình

| Giai đoạn | Nội dung | Xong khi |
|---|---|---|
| 0. Nền | Monorepo, Electron khung, CI, ký mã, tự cập nhật | Cài được bản trống trên Windows, tự cập nhật được |
| 1. Điều phối | Adapter SDK + claude, codex, opencode, gemini, pty; giao diện chat nhiều agent; chuyển việc giữa agent; test hợp đồng hằng đêm | Một việc chạy qua 2 agent khác nhau, giữ ngữ cảnh |
| 2. NSA Mem | Cây nhánh, tìm kiếm, hộp duyệt, chắt lọc tự động, nhập lịch sử chat | Agent B nhớ điều đã dạy agent A |
| 3. App Store | Plugin host, MCP gateway, quyền, SDK, màn hình lưới + Quản lý | Cài/gỡ một plugin mẫu không cần khởi động lại |
| 4. Kênh chat | Telegram, Discord, Zalo; nhớ theo nhóm/nick; canh nhóm theo lô | Bot trả lời đúng nội quy từng nhóm |
| 5. Knowledge Base | Dạy bằng tài liệu, ảnh, video; giao diện duyệt | Dạy bằng 1 video, hỏi lại trả lời đúng |
| 6. Tự động hoá | Hẹn giờ, điều khiển trình duyệt (Playwright) | Việc theo lịch chạy khi không ai ngồi máy |
| 7. Content Factory | Slide, video motion, SVG, case study | Ra được 1 slide + 1 video từ một yêu cầu |
| 8. Thương mại | License, thanh toán, kho plugin trực tuyến, tài liệu, macOS | Người lạ mua, cài, dùng được không cần hỗ trợ |

Giai đoạn 1–3 là lõi, làm tuần tự. Giai đoạn 4–7 là plugin, làm song song được sau khi xong 3. Việc của giai đoạn 8 liên quan đến ký mã và tự cập nhật được dựng khung từ giai đoạn 0.

## Rủi ro cần biết trước

- **Zalo cá nhân dùng API không chính thức**: có thể bị khoá nick và vi phạm điều khoản Zalo. Với sản phẩm bán ra, cần ghi rõ cảnh báo và hỗ trợ thêm Zalo OA chính thức.
- **Điều khoản của nhà cung cấp**: việc tự động hoá CLI bằng gói thuê bao cá nhân trong sản phẩm thương mại cần đọc kỹ điều khoản từng hãng; phương án dự phòng là cho người dùng nhập API key riêng.
- **Tầng PTY dễ vỡ** khi giao diện terminal đổi; chỉ dùng làm lưới an toàn, không làm đường chính.
- **Bộ nhớ tự duyệt có thể học sai**: bắt buộc có nguồn gốc, hoàn tác và hộp duyệt cho quy tắc hành vi.

