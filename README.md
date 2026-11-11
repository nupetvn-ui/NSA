# NSA

App desktop điều phối nhiều agent AI chạy qua CLI (Claude Code, Codex, OpenCode, Gemini CLI…), kèm App Store công cụ cài thêm và bộ nhớ riêng tự học, tự duyệt.

Ba trụ cột:

- **Điều phối** — mỗi CLI là một adapter rời, nhà cung cấp update thì chỉ cần cập nhật adapter.
- **NSA Mem** — bộ nhớ nằm trên máy người dùng, agent nào cũng dùng chung; dạy bằng văn bản, ảnh, video và lịch sử chat.
- **App Store** — plugin theo chuẩn MCP: Zalo, Telegram, Discord, Knowledge Base, Hẹn giờ, tự động hoá trình duyệt, Content Factory.

Kế hoạch tổng thể: [docs/PLAN.md](docs/PLAN.md) · Quyết định kỹ thuật: [docs/adr/](docs/adr/README.md)

Trạng thái: **giai đoạn 0 (Nền)** — khung monorepo, app Electron trống, đóng gói Windows, khung tự cập nhật, CI.

## Cài đặt môi trường

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
4. Kiểm tra rồi bấm **Publish** trên GitHub — từ lúc đó app đã cài sẽ tự tải bản mới và cài khi thoát.

Ký mã: đặt secret `WIN_CSC_LINK` (file `.pfx` mã hoá base64 hoặc URL) và `WIN_CSC_KEY_PASSWORD` trong repo. Chưa đặt thì bộ cài vẫn tạo được nhưng không ký (Windows sẽ cảnh báo khi cài). Chi tiết: [ADR-0003](docs/adr/0003-dong-goi-va-tu-cap-nhat.md).
