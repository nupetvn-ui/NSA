# plugins

Các app của App Store (zalo, telegram, discord, knowledge-base, scheduler, browser, content-factory), mỗi app một thư mục có `nsa-plugin.json`. Làm từ giai đoạn 3 — xem [docs/PLAN.md](../docs/PLAN.md).

Kênh chat (giai đoạn 4, [ADR-0011](../docs/adr/0011-kenh-chat-plugin-khe-bi-mat-va-canh-nhom-theo-lo.md)): [`telegram`](telegram), [`discord`](discord), [`lark`](lark), [`zalo-oa`](zalo-oa) (chính thức), [`zalo-ca-nhan`](zalo-ca-nhan) (KHÔNG chính thức, chỉ bản Cá nhân). Phần dùng chung nằm ở [`_kit`](_kit) và được chép vào từng plugin bằng `node plugins/sync-kit.mjs` — sửa ở `_kit` rồi chạy lại lệnh đó.

Công cụ Google Workspace cho agent (giai đoạn 4, [ADR-0012](../docs/adr/0012-quyen-cli-va-plugin-google-workspace.md)): [`google-workspace`](google-workspace) — dùng quyền `cli` để lõi chạy `gws`.

Công cụ bán hàng: [`kiotviet`](kiotviet) — Public API KiotViet cho agent ([ADR-0013](../docs/adr/0013-plugin-kiotviet.md)).

Kho tri thức (giai đoạn 5, [ADR-0014](../docs/adr/0014-knowledge-base.md)): [`knowledge-base`](knowledge-base) — dạy bằng tài liệu / ảnh / video, duyệt, hỏi lại kèm nguồn. Mã nguồn ở `src/`, đóng gói thành `main.js` bằng `pnpm --filter @nsa/plugin-knowledge-base build` (sửa `src/` thì build lại rồi commit `main.js`).

Có sẵn: [`ghi-chu-nhanh`](ghi-chu-nhanh) — plugin mẫu (một tool MCP, một màn hình, một việc nền, một nhánh nhớ). Cách viết: [docs/viet-plugin-dau-tien.md](../docs/viet-plugin-dau-tien.md).
