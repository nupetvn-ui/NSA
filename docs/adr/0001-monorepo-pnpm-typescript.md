# ADR-0001: Monorepo pnpm + TypeScript strict

- Trạng thái: Chấp nhận
- Ngày: 2026-11-11

## Bối cảnh

NSA gồm app desktop, lõi, SDK adapter, nhiều adapter CLI, cổng MCP, bộ nhớ, SDK plugin và nhiều plugin (xem [PLAN.md](../PLAN.md)). Adapter và plugin phải phát hành độc lập với app, nên cần ranh giới gói rõ ràng ngay từ đầu.

## Quyết định

- **pnpm workspace** (`apps/*`, `packages/*`, `packages/adapters/*`, `plugins/*`). Ghim `packageManager: pnpm@10.33.0` và Node 24 LTS (`.nvmrc`, `engines`, `engine-strict`).
- **TypeScript 6.0, strict** qua `tsconfig.base.json` dùng chung, bật thêm `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `verbatimModuleSyntax`.
  - Chưa lên TypeScript 7 (bản viết lại bằng Go) vì typescript-eslint hiện chỉ hỗ trợ `<6.1`.
- Mỗi gói thư viện build bằng `tsc` ra `dist/` (ESM + `.d.ts`). Trường `exports` có thêm điều kiện riêng `@nsa/source` trỏ tới `src/index.ts`; `tsconfig` bật `customConditions` nên typecheck giữa các gói đọc thẳng mã nguồn, không phải build trước.
- **ESLint 10** (flat config, typescript-eslint, react-hooks) + **Prettier** cho định dạng; `pnpm lint` chạy cả hai.
- **Vitest** chạy test toàn repo từ gốc (`vitest.config.ts`).

## Hệ quả

- Thêm adapter/plugin mới = thêm một thư mục có `package.json`, không đụng cấu hình gốc.
- Gói chưa làm chỉ là khung rỗng (`export {}`), build được nhưng chưa có logic.
- Nâng TypeScript 7 khi typescript-eslint hỗ trợ — viết ADR mới.
