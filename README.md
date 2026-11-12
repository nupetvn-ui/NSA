# NSA

App desktop điều phối nhiều agent AI chạy qua CLI (Claude Code, Codex, OpenCode, Gemini CLI…), kèm App Store công cụ cài thêm và bộ nhớ riêng tự học, tự duyệt.

Ba trụ cột:

- **Điều phối** — mỗi CLI là một adapter rời, nhà cung cấp update thì chỉ cần cập nhật adapter.
- **NSA Mem** — bộ nhớ nằm trên máy người dùng, agent nào cũng dùng chung; dạy bằng văn bản, ảnh, video và lịch sử chat.
- **App Store** — plugin theo chuẩn MCP: Zalo, Telegram, Discord, Knowledge Base, Hẹn giờ, tự động hoá trình duyệt, Content Factory.

Kế hoạch tổng thể: [docs/PLAN.md](docs/PLAN.md) · Quyết định kỹ thuật: [docs/adr/](docs/adr/README.md)

Trạng thái: **dùng được** — chat với Claude Code và Codex trong cùng một app, đổi agent giữa chừng (NSA tự chuyển ngữ cảnh), xem agent chạy lệnh/sửa file theo thời gian thực. Nền: monorepo, đóng gói Windows, khung tự cập nhật, CI.

## Dùng NSA

1. Cài CLI của agent muốn dùng (một lần), rồi đăng nhập từng cái:

```bash
npm install -g @anthropic-ai/claude-code @openai/codex
```

```bash
claude auth login
```

```bash
codex login
```

2. Mở NSA, bấm biểu tượng soạn tin ở thanh bên, chọn thư mục dự án và bật/tắt **Cho sửa file** (tắt = agent chỉ đọc và lập kế hoạch).
3. Chọn agent (Claude Code / Codex) ngay trên ô nhập, gõ yêu cầu, Enter để gửi. Lượt sau có thể đổi agent — agent mới nhận tóm tắt những gì agent trước đã làm.
4. Góc dưới thanh bên cho biết agent nào đã cài / đã đăng nhập; bấm **Kiểm lại** sau khi cài hoặc đăng nhập.

Cuộc trò chuyện được lưu ở `%APPDATA%\NSA\conversations.json`.

## Cài đặt môi trường (cho lập trình viên)

Cần:

- **Node.js 24** (phiên bản ghim trong [`.nvmrc`](.nvmrc))
- **pnpm 10** — bật qua corepack đi kèm Node:

```bash
corepack enable
```

Cài thư viện (lần đầu, từ thư mục gốc repo):

```bash
pnpm install
```

Lần chạy đầu, Electron tự tải file chạy của nó (~100 MB).

## Lệnh thường dùng

| Lệnh             | Việc                                                                          |
| ---------------- | ----------------------------------------------------------------------------- |
| `pnpm dev`       | Mở app desktop ở chế độ dev (sửa giao diện là thấy ngay)                      |
| `pnpm lint`      | ESLint + kiểm định dạng Prettier                                              |
| `pnpm format`    | Tự định dạng lại mã                                                           |
| `pnpm typecheck` | Kiểm kiểu TypeScript cho mọi gói                                              |
| `pnpm test`      | Chạy test (Vitest)                                                            |
| `pnpm build`     | Build mọi gói thư viện và app desktop                                         |
| `pnpm dist:win`  | Tạo bộ cài Windows ở `apps/desktop/release/<version>/NSA-Setup-<version>.exe` |

Logo gốc ở [`apps/desktop/build/icon.svg`](apps/desktop/build/icon.svg). Sửa xong thì xuất lại các file PNG:

```bash
pnpm --filter @nsa/desktop icons
```

## Cấu trúc

```
apps/desktop          Electron + React (main / preload / renderer)
packages/core         lõi NSA: hợp đồng IPC, orchestrator (sẽ làm)
packages/adapter-sdk  hợp đồng adapter CLI (khung)
packages/adapters/*   adapter từng CLI (giai đoạn 1)
packages/mcp-gateway  cổng MCP (khung)
packages/memory       NSA Mem (khung)
packages/plugin-sdk   SDK plugin (khung)
plugins/*             app của App Store (giai đoạn 3+)
docs/                 kế hoạch, ADR
```

## Phát hành

1. Tăng `version` trong `apps/desktop/package.json`, commit, merge vào `main`.
2. Gắn tag trùng version, ví dụ `v0.1.0`, và push tag.
3. Workflow **Release Windows** build bộ cài và tạo GitHub Release dạng **nháp**.
4. Kiểm tra rồi bấm **Publish** trên GitHub. Từ lúc đó, app đã cài sẽ tự tải bản mới (kiểm khi mở app và mỗi 4 giờ). Thanh bên hiện **Khởi động lại** để cài ngay; nếu không bấm thì app tự cài khi thoát.

Thử tự cập nhật mà không phát hành lên GitHub:

1. Build bản cũ, cài thử.
2. Tăng version, build lại. Đặt `latest.yml`, bộ cài mới và file `.blockmap` của cả hai bản vào một thư mục, rồi phục vụ thư mục đó qua HTTP.
3. Mở bản cũ với biến môi trường `NSA_UPDATE_URL` trỏ tới thư mục đó (ví dụ `http://127.0.0.1:8765/`).

Ký mã: đặt secret `WIN_CSC_LINK` (file `.pfx` mã hoá base64 hoặc URL) và `WIN_CSC_KEY_PASSWORD` trong repo. Chưa đặt thì bộ cài vẫn tạo được nhưng không ký (Windows sẽ cảnh báo khi cài). Chi tiết: [ADR-0003](docs/adr/0003-dong-goi-va-tu-cap-nhat.md).
