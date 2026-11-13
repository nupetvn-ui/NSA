# plugins

Các app của App Store (zalo, telegram, discord, knowledge-base, scheduler, browser, content-factory), mỗi app một thư mục có `nsa-plugin.json`. Làm từ giai đoạn 3 — xem [docs/PLAN.md](../docs/PLAN.md).

Kênh chat (giai đoạn 4, [ADR-0011](../docs/adr/0011-kenh-chat-plugin-khe-bi-mat-va-canh-nhom-theo-lo.md)): [`telegram`](telegram), [`discord`](discord), [`zalo-oa`](zalo-oa) (chính thức), [`zalo-ca-nhan`](zalo-ca-nhan) (KHÔNG chính thức, chỉ bản Cá nhân). Phần dùng chung nằm ở [`_kit`](_kit) và được chép vào từng plugin bằng `node plugins/sync-kit.mjs` — sửa ở `_kit` rồi chạy lại lệnh đó.

Có sẵn: [`ghi-chu-nhanh`](ghi-chu-nhanh) — plugin mẫu (một tool MCP, một màn hình, một việc nền, một nhánh nhớ). Cách viết: [docs/viet-plugin-dau-tien.md](../docs/viet-plugin-dau-tien.md).
