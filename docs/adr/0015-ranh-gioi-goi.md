# ADR-0015: Ranh giới gói — lõi chỉ giữ interface, lắp ghép ở apps/desktop (G3)

- Trạng thái: Chấp nhận
- Ngày: 2026-11-13

## Bối cảnh

Rà kiến trúc (`docs/PLAN.md`, mục "Gia cố nền") thấy phụ thuộc đang đi ngược: `@nsa/core` phụ thuộc `@nsa/providers` (kiểu của màn hình Nhà cung cấp) và `@nsa/adapter-api` (trong test); `@nsa/providers` import thẳng adapter Claude, Codex, OpenCode. Hệ quả: lõi không còn "chỉ có ổ cắm", bản Doanh nghiệp khó thay từng mảnh, và adapter không thể cập nhật độc lập với app (G1) khi gói khác khoá cứng vào chúng.

## Quyết định

Bốn tầng, mũi tên chỉ đi một chiều (người import → người được import):

```
apps/desktop  (lắp ghép: được import mọi gói, tạo adapter, hub, bộ nhớ, plugin host, rồi cắm vào lõi)
     │
     ▼
hiện thực:  adapters/{claude,codex,opencode,gemini,antigravity,api,pty}   providers   memory   mcp-gateway   plugin-host
     │
     ▼
core  (interface + logic điều phối: ChatService, router, ổ cắm chính sách / nhật ký / danh tính / bộ nhớ, kiểu IPC)
     │
     ▼
hợp đồng:  adapter-sdk   plugin-sdk      (không import gói @nsa nào)
```

Bảng cho phép (nguồn duy nhất: [`package-boundaries.js`](../../package-boundaries.js)):

| Gói                                                | Được import                               |
| -------------------------------------------------- | ----------------------------------------- |
| `adapter-sdk`, `plugin-sdk`                        | — (không gói @nsa nào)                    |
| `core`                                             | `adapter-sdk`, `plugin-sdk`               |
| `adapter-pty`, `adapter-api`                       | `adapter-sdk`                             |
| `adapter-claude/codex/opencode/gemini/antigravity` | `adapter-sdk`, `adapter-pty`              |
| `providers`                                        | `core`, `adapter-sdk`, `adapter-api`      |
| `mcp-gateway`                                      | `core`, `adapter-sdk`                     |
| `memory`                                           | `core`, `adapter-sdk`, `mcp-gateway`      |
| `plugin-host`                                      | `core`, `mcp-gateway`, `plugin-sdk`       |
| `contract-live` (test với CLI thật)                | mọi gói trừ `plugin-*` (ghép như desktop) |
| `apps/desktop`                                     | tất cả                                    |

Nguyên tắc: gói hiện thực biết lõi, lõi không biết gói hiện thực. Hai gói hiện thực chỉ biết nhau khi bảng ghi rõ (`memory → mcp-gateway`). `providers → adapter-api` được giữ vì hub tạo adapter gọi thẳng API là phần cốt lõi của nó; còn adapter của từng CLI thì **không**.

### Các thay đổi để đạt sơ đồ

1. **Kiểu của màn hình Nhà cung cấp chuyển vào lõi.** `ProvidersView`, `ProviderSettingsPatch`, `CheckResult`, `TaskKind` và các kiểu dữ liệu hãng/model/chi phí mà chúng kéo theo nay nằm ở `packages/core/src/providers-types.ts` (chỉ có kiểu, không có mã chạy). `@nsa/providers` import lại và **xuất lại** đúng các tên cũ, nên mọi chỗ import `@nsa/providers` giữ nguyên.
2. **`ProviderHub` nhận adapter CLI lúc lắp ghép.** Tuỳ chọn mới bắt buộc `cliAdapters: CliAdapterFactories` (hàm tạo adapter cho `claude` / `codex` / `opencode`). `apps/desktop/src/main/agents.ts` xuất `cliAdapterFactories` và cắm vào; test của providers dùng adapter giả. Đây là chỗ G1 sẽ thay bằng adapter nạp từ gói tải về.
3. **Test dùng cả lõi lẫn adapter API chuyển sang `providers`.** `model-tasks.test.ts` (chạy `ModelTaskRunner` với adapter `api` và máy chủ giả) chuyển từ `core` sang `packages/providers/src`, vì nó là test tích hợp của hai gói; lõi không còn `devDependency` nào.
4. **Gỡ phụ thuộc khai báo thừa:** `core` bỏ `providers` và `adapter-api`; `providers` bỏ `adapter-claude`, `adapter-codex`, `adapter-opencode`, thêm `core`.

### Chặn vi phạm mới

- **Lint:** `eslint.config.js` sinh, từ bảng trên, một luật `no-restricted-imports` cho từng gói: cấm mọi `@nsa/*` trừ các gói được phép (kể cả `import type`). Import vượt sơ đồ làm `pnpm lint` đỏ, thông báo trỏ về ADR này.
- **Test:** `packages/boundaries.test.ts` (a) kiểm `dependencies` / `devDependencies` của mọi `package.json` không vượt bảng và mọi gói mới phải khai báo trong bảng; (b) chạy ESLint thật trên mã mẫu để chứng minh luật bắt được các vi phạm điển hình (core → providers, core → adapter-api, providers → adapter-claude, memory → providers, adapter → core…) và không chặn import hợp lệ.

## Hệ quả

- Lõi không phụ thuộc gói hiện thực nào; thay `memory`, `providers`, `plugin-host` hay một adapter bằng bản khác chỉ đụng nơi lắp ghép.
- API công khai: **không đổi** với plugin và với giai đoạn 5, trừ một điểm: `new ProviderHub({...})` giờ yêu cầu thêm `cliAdapters` (chỉ `apps/desktop`, test của providers và `contract-live` gọi nó; đã sửa cả ba). Mọi tên kiểu cũ của `@nsa/providers` và `@nsa/core` vẫn import được từ chỗ cũ.
- Chưa chặn: import tương đối chui qua thư mục gói khác (`../../other/src`) — hiếm, workspace dùng tên gói; bổ sung nếu gặp. `plugins/*` (JavaScript, chạy trong tiến trình riêng) nằm ngoài sơ đồ này.
- Giai đoạn 5 đang sửa `packages/memory`: sơ đồ cho phép `memory → core, adapter-sdk, mcp-gateway` đúng như hiện tại. Nếu nó cần thêm cạnh khác, sửa `package-boundaries.js` kèm lý do trong PR đó.

## Kết quả

Xem phần "Kết quả kiểm" trong mô tả PR và mục G3 trong `docs/PLAN.md`.
